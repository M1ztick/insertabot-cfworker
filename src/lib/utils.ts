/**
 * Origins allowed to make cross-origin requests.
 *
 * The preflight handler used to echo whatever `Origin` the caller sent, which
 * made every site an allowed origin. Nothing was immediately exploitable —
 * `Allow-Credentials` is not set, and Cloudflare Access guards the agent
 * routes — but reflecting an arbitrary origin is a door that only has to be
 * pushed once: adding credentials support later would silently turn it into a
 * real cross-site read. An allowlist fails closed instead.
 *
 * Native clients (the Android app, which drives `/agents/*` over OkHttp) send
 * no `Origin` header at all and never consult CORS, so tightening this cannot
 * affect them. It governs browsers only.
 */
const ALLOWED_ORIGINS: readonly string[] = Object.freeze([
	'https://cfworker.insertabot.io',
	'https://insertabot.io',
	'https://www.insertabot.io',
]);

/** Local dev origins, allowed in addition to the list above. */
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/** Headers shared by every CORS response, regardless of origin. */
const BASE_CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

/** True when `origin` is permitted to read cross-origin responses. */
export function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) return false;
	return ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN_RE.test(origin);
}

/**
 * Build CORS headers for a request's `Origin`.
 *
 * An allowed origin is echoed back; anything else simply gets no
 * `Access-Control-Allow-Origin`, which is what makes the browser block the
 * read. `Vary: Origin` is always set so a cache cannot serve one origin's
 * CORS decision to another.
 */
export function corsHeaders(origin?: string | null): Record<string, string> {
	const headers: Record<string, string> = { ...BASE_CORS_HEADERS, Vary: 'Origin' };
	if (isAllowedOrigin(origin ?? null)) {
		headers['Access-Control-Allow-Origin'] = origin as string;
	}
	return headers;
}

/** Build a JSON Response with optional status and extra headers. */
export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...extraHeaders,
		},
	});
}

/** Safely extract a message from an unknown error value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
