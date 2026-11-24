/**
 * Keep conversation content and credentials out of logs.
 *
 * Workers Logs persist what the Worker prints, and anyone with dashboard access
 * can read them. Two things must never reach them:
 *
 *  - Secrets carried in URLs. Several MCP servers take their API key as a query
 *    parameter (Tavily `?tavilyApiKey=`, Exa `?exaApiKey=`), and the PWA's key
 *    rides as `?ib_key=`. A logged URL is a leaked key.
 *  - Message text. AI SDK errors (`APICallError`) carry `requestBodyValues` and
 *    `responseBody`, i.e. the whole prompt and reply; logging the error object
 *    prints them. Only the error's kind, status and message are logged.
 */

const MAX_MESSAGE = 300;

/** Scheme, host and path only: no query, fragment or `user:pass@`. */
export function safeUrl(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return '[invalid url]';
	}
}

/**
 * One line describing an error, without its payload: the name, an HTTP status
 * if it carries one, and a bounded message with any URLs reduced by safeUrl().
 */
export function errorSummary(err: unknown): string {
	if (err === null || err === undefined) return 'unknown error';
	if (typeof err !== 'object') return clipMessage(String(err));
	const e = err as { name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown };
	const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
	const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.status === 'number' ? e.status : null;
	const message = typeof e.message === 'string' ? clipMessage(e.message) : '';
	return [name, status !== null ? `(HTTP ${status})` : '', message ? `: ${message}` : '']
		.join('')
		.replace(' :', ':')
		.trim();
}

function clipMessage(message: string): string {
	const scrubbed = message.replace(/https?:\/\/[^\s"'<>]+/g, (m) => safeUrl(m));
	const flat = scrubbed.replace(/\s+/g, ' ').trim();
	return flat.length <= MAX_MESSAGE ? flat : `${flat.slice(0, MAX_MESSAGE - 1)}…`;
}
