/**
 * Lightweight shared utilities — no heavy deps.
 */

/** Generate a short random ID (format: `msg_{base36timestamp}_{rand}`) */
export function generateId(prefix = 'msg'): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Safely parse JSON without throwing */
export function safeJsonParse<T = unknown>(str: string, fallback: T): T {
	try {
		return JSON.parse(str) as T;
	} catch {
		return fallback;
	}
}

/** Simple async wrapper with timeout */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
	);
	return Promise.race([promise, timeout]);
}

/** Deep-clone via structured clone (Workers-safe) */
export function deepClone<T>(obj: T): T {
	return structuredClone(obj);
}

/** Truncate text with ellipsis */
export function truncate(str: string, maxLen = 500): string {
	return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

/** Basic CORS headers */
export function corsHeaders(origin = '*'): HeadersInit {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
}

/** Respond with JSON + proper headers */
export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...extraHeaders,
		},
	});
}

/** Create a SSE (Server-Sent Events) response stream */
export function sseStream(reader: ReadableStreamDefaultReader<Uint8Array>): Response {
	return new Response(
		new ReadableStream({
			async start(controller) {
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						controller.enqueue(value);
					}
				} catch (err) {
					controller.error(err);
				} finally {
					controller.close();
				}
			},
		}),
		{
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				...corsHeaders(),
			},
		}
	);
}
