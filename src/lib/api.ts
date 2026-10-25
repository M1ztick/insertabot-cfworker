/**
 * REST API for the cross-device conversation list.
 *
 *   GET    /api/conversations?limit=&cursor=   list, most recent first
 *   GET    /api/conversations/:id              one entry
 *   PATCH  /api/conversations/:id              { "title": "..." } — rename
 *   DELETE /api/conversations/:id              delete thread + its history
 *
 * Message bodies are not served here. A client opens a conversation by
 * connecting its WebSocket to /agents/chat-agent/:id, exactly as before; the
 * agent sends the stored transcript on connect. This API only answers "which
 * conversations exist", which a Durable Object cannot.
 *
 * The caller is authenticated by the Worker before this module is reached,
 * and the owner is always the verified principal's — never a request field.
 */

import { getAgentByName } from 'agents';
import type { Principal } from './auth';
import { scopedInstanceId } from './auth';
import {
	deleteConversation,
	ensureSchema,
	getConversation,
	isValidConversationId,
	listConversations,
	normalizeTitle,
	renameConversation,
} from './conversations';
import { jsonResponse } from './utils';

export const API_PREFIX = '/api/';
const COLLECTION = '/api/conversations';

/** Minimal surface of the ChatAgent stub this module calls. */
interface PurgeableStub {
	purge(): Promise<void>;
}

/**
 * getAgentByName (not a raw idFromName/get) because it also sets the agent's
 * name, which Agent code reads and throws on when unset. Viewed through a
 * narrow signature: its own return type, DurableObjectStub<Agent>, recurses
 * deeply enough to trip tsc's instantiation limit (TS2589).
 */
const agentByName = getAgentByName as unknown as (
	namespace: DurableObjectNamespace,
	name: string,
) => Promise<PurgeableStub>;

export interface ApiEnv {
	DB?: D1Database;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	ChatAgent: DurableObjectNamespace<any>;
}

export function isApiRoute(pathname: string): boolean {
	return pathname === '/api' || pathname.startsWith(API_PREFIX);
}

type Route = { kind: 'collection' } | { kind: 'item'; id: string } | null;

export function matchRoute(pathname: string): Route {
	if (pathname === COLLECTION || pathname === `${COLLECTION}/`) return { kind: 'collection' };
	if (!pathname.startsWith(`${COLLECTION}/`)) return null;
	const rest = pathname.slice(COLLECTION.length + 1).replace(/\/$/, '');
	if (!rest || rest.includes('/')) return null;
	let id: string;
	try {
		id = decodeURIComponent(rest);
	} catch {
		return null;
	}
	return { kind: 'item', id };
}

function error(status: number, message: string, headers: Record<string, string>): Response {
	return jsonResponse({ error: message }, status, headers);
}

async function readTitle(request: Request): Promise<string | null> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return null;
	}
	if (!body || typeof body !== 'object') return null;
	const title = normalizeTitle((body as { title?: unknown }).title);
	return title || null;
}

export async function handleApi(
	request: Request,
	env: ApiEnv,
	principal: Principal,
	cors: Record<string, string>,
): Promise<Response> {
	const url = new URL(request.url);
	const route = matchRoute(url.pathname);
	if (!route) return error(404, 'Not found', cors);

	const db = env.DB;
	if (!db) return error(503, 'Conversation history is not configured on this Worker', cors);
	await ensureSchema(db);

	const owner = principal.owner;

	if (route.kind === 'collection') {
		if (request.method !== 'GET') {
			return error(405, 'Method not allowed', { ...cors, Allow: 'GET' });
		}
		const page = await listConversations(db, owner, {
			limit: Number(url.searchParams.get('limit')) || undefined,
			cursor: url.searchParams.get('cursor'),
		});
		return jsonResponse(page, 200, { ...cors, 'Cache-Control': 'no-store' });
	}

	const { id } = route;
	if (!isValidConversationId(id)) return error(400, 'Invalid conversation id', cors);

	switch (request.method) {
		case 'GET': {
			const conversation = await getConversation(db, owner, id);
			return conversation
				? jsonResponse(conversation, 200, { ...cors, 'Cache-Control': 'no-store' })
				: error(404, 'Conversation not found', cors);
		}

		case 'PATCH': {
			const title = await readTitle(request);
			if (!title) return error(400, 'Body must be JSON with a non-empty "title"', cors);
			const updated = await renameConversation(db, owner, id, title);
			return updated ? jsonResponse(updated, 200, cors) : error(404, 'Conversation not found', cors);
		}

		case 'DELETE': {
			// History first, index second. If purging fails the row survives
			// and the user can retry; the reverse order would orphan messages
			// that nothing lists any more and nobody could delete.
			//
			// The Durable Object is addressed by the same owner-scoped name the
			// WebSocket route derives, so this can only reach the caller's own.
			const name = scopedInstanceId(principal, id);
			const stub = await agentByName(env.ChatAgent, name);
			await stub.purge();
			const removed = await deleteConversation(db, owner, id);
			// 204 either way: after this call the conversation does not exist,
			// which is what the client asked for. Report whether it was listed.
			return new Response(null, {
				status: 204,
				headers: { ...cors, 'X-Conversation-Indexed': removed ? '1' : '0' },
			});
		}

		default:
			return error(405, 'Method not allowed', { ...cors, Allow: 'GET, PATCH, DELETE' });
	}
}
