/** Frozen base CORS headers (safe to spread into new Headers). */
const BASE_CORS_HEADERS: HeadersInit = Object.freeze({
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
});

/** Return a copy of the default CORS headers, optionally with a custom origin. */
export function corsHeaders(origin = '*'): HeadersInit {
	if (origin === '*') return BASE_CORS_HEADERS;
	return { ...BASE_CORS_HEADERS, 'Access-Control-Allow-Origin': origin };
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
