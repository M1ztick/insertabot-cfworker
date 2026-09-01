/**
 * Authentication for the agent transport, behind Cloudflare Access.
 *
 * Access terminates auth in front of the Worker and injects a signed JWT as
 * `Cf-Access-Jwt-Assertion`. The header's PRESENCE proves nothing on its own —
 * any route to the Worker that the Access application does not cover would let
 * a client set that header itself. This Worker sets `workers_dev: false` and
 * `preview_urls: false` in wrangler.jsonc, so the custom domain is the only
 * route in, and the Access app covers it. The JWT is still verified here.
 *
 * Two client flows, one code path:
 *   - Browsers (the PWA) hold a CF_Authorization cookie, which IS sent on a
 *     same-origin WebSocket upgrade. Access converts it to the JWT header.
 *   - Native clients cannot complete an interactive login and use a service
 *     token instead (CF-Access-Client-Id / CF-Access-Client-Secret, which
 *     OkHttp sets on the upgrade). Access converts those to the same header.
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';

export interface Principal {
	/** Stable identity for this caller. */
	userId: string;
	/** Path-safe, collision-resistant digest of userId. Prefixes instance ids. */
	owner: string;
	/** True when the caller authenticated with a service token, not a login. */
	isService: boolean;
}

interface AccessPayload extends JWTPayload {
	email?: string;
	/** Client ID of the service token. Present ONLY on service-token auth. */
	common_name?: string;
}

export interface AuthEnv {
	/** https://<team-name>.cloudflareaccess.com */
	TEAM_DOMAIN?: string;
	/** The Access application's AUD tag. */
	POLICY_AUD?: string;
}

/**
 * Cached per team domain so a JWKS fetch happens once per isolate rather than
 * once per request. Keyed on the domain so a config change cannot be served by
 * a stale key set. `createRemoteJWKSet` handles its own refresh on rotation.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keySet(teamDomain: string) {
	let set = jwksCache.get(teamDomain);
	if (!set) {
		set = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, set);
	}
	return set;
}

/**
 * Derive a stable identity from an Access JWT.
 *
 * On service-token authentication Access sets `sub` to an EMPTY STRING and puts
 * the token's Client ID in `common_name`. Keying off `sub` alone would collapse
 * every service-token caller into one blank identity — so every tester would
 * share a single Durable Object namespace and read each other's conversations.
 * Resolve in this order, and treat a payload with none of the three as
 * unauthenticated.
 */
function identityOf(payload: AccessPayload): { userId: string; isService: boolean } | null {
	if (payload.common_name) return { userId: `svc:${payload.common_name}`, isService: true };
	if (payload.email) return { userId: `usr:${payload.email.toLowerCase()}`, isService: false };
	if (typeof payload.sub === 'string' && payload.sub.length > 0) {
		return { userId: `sub:${payload.sub}`, isService: false };
	}
	return null;
}

/**
 * Durable Object names accept arbitrary strings, but these ids also travel in a
 * URL path, and emails contain characters that are awkward there. SHA-256 keeps
 * the owner half short, path-safe, and collision-resistant — a collision here
 * would merge two users' conversation namespaces, so a non-cryptographic hash
 * is not good enough.
 */
async function digestOwner(userId: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
	const hex = Array.from(new Uint8Array(bytes))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	// 128 bits is far past any birthday bound that matters at this scale.
	return hex.slice(0, 32);
}

/**
 * Verify the Access JWT on an incoming request and resolve the caller.
 * Returns null for anything that does not verify.
 */
export async function authenticate(request: Request, env: AuthEnv): Promise<Principal | null> {
	if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
		// Fail closed. A misconfigured Worker must not serve agent traffic
		// unauthenticated — that is the exact state this module exists to fix.
		console.error('[auth] TEAM_DOMAIN or POLICY_AUD is not configured; refusing agent traffic');
		return null;
	}

	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return null;

	let payload: AccessPayload;
	try {
		({ payload } = await jwtVerify<AccessPayload>(token, keySet(env.TEAM_DOMAIN), {
			issuer: env.TEAM_DOMAIN,
			audience: env.POLICY_AUD,
		}));
	} catch (err) {
		console.warn('[auth] JWT verification failed:', (err as Error).message);
		return null;
	}

	const identity = identityOf(payload);
	if (!identity) return null;

	return { ...identity, owner: await digestOwner(identity.userId) };
}

/**
 * Access authenticates the caller; it does not decide which Durable Object they
 * may open. Instance ids are client-chosen, so without scoping an authenticated
 * user could name someone else's instance and read their history — over the
 * socket, or over GET /agents/chat-agent/<id>/get-messages.
 *
 * The owner half is DERIVED from the verified principal rather than validated
 * against a client-supplied prefix: a check can be forgotten on a new route,
 * whereas a derived name is unforgeable by construction. The client keeps
 * sending a bare conversation id and needs no changes.
 *
 * Path shape: /agents/chat-agent/<owner>~<conversationId>
 */
const INSTANCE_SEPARATOR = '~';

export function scopedInstanceId(principal: Principal, conversationId: string): string {
	// Strip the separator from the client-supplied half so a crafted
	// conversation id cannot introduce a second owner boundary.
	const safe = conversationId.split(INSTANCE_SEPARATOR).join('-');
	return `${principal.owner}${INSTANCE_SEPARATOR}${safe}`;
}

/** Defence in depth for any route that reads the instance id straight off the path. */
export function isOwnedInstance(instanceId: string, principal: Principal): boolean {
	const idx = instanceId.indexOf(INSTANCE_SEPARATOR);
	if (idx <= 0) return false;
	return instanceId.slice(0, idx) === principal.owner;
}

/**
 * Split an agent route into its parts.
 *
 * Returns null when the path is not an agent route at all, so non-agent traffic
 * (health, assets) is left alone by the caller.
 */
export function parseAgentRoute(
	url: URL,
	prefix = 'agents',
): { agent: string; instance: string; rest: string[] } | null {
	const segments = url.pathname.split('/').filter(Boolean);
	// [prefix, kebab-class, instance, ...rest]
	if (segments.length < 3 || segments[0] !== prefix) return null;
	let instance: string;
	try {
		instance = decodeURIComponent(segments[2]);
	} catch {
		// A malformed escape (`%`, `%ZZ`) would otherwise throw past the handler
		// and surface as a 500. Treat it as a non-route and let the caller 404.
		return null;
	}
	return { agent: segments[1], instance, rest: segments.slice(3) };
}
