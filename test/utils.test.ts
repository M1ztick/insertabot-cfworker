import { describe, it, expect } from 'vitest';
import { corsHeaders, isAllowedOrigin, jsonResponse, errorMessage } from '../src/lib/utils';

/**
 * Regression: the preflight handler echoed back whatever `Origin` the caller
 * sent, so every site was an allowed origin. Not immediately exploitable
 * (`Allow-Credentials` is unset and Access guards the agent routes), but it
 * becomes a real cross-site read the moment credentials support is added.
 */
describe('isAllowedOrigin', () => {
	it.each([
		'https://cfworker.insertabot.io',
		'https://insertabot.io',
		'https://www.insertabot.io',
	])('allows the known origin %s', (origin) => {
		expect(isAllowedOrigin(origin)).toBe(true);
	});

	// Note: against a dev server on :8787, a preflight carrying
	// `Origin: http://localhost:8787` comes back with no Allow-Origin header.
	// That is not this allowlist rejecting it — the runtime drops the header
	// because the request is same-origin, where CORS does not apply. Other
	// localhost ports are echoed normally.
	it.each(['http://localhost:8787', 'http://localhost', 'http://127.0.0.1:3000', 'https://[::1]:8080'])(
		'allows the local dev origin %s',
		(origin) => {
			expect(isAllowedOrigin(origin)).toBe(true);
		},
	);

	it.each([
		'https://evil.example',
		'https://insertabot.io.evil.example',
		'https://notinsertabot.io',
		'http://insertabot.io',
		'https://insertabot.io:8443',
		'null',
		'',
	])('rejects the untrusted origin %j', (origin) => {
		expect(isAllowedOrigin(origin)).toBe(false);
	});

	it('rejects a missing Origin header', () => {
		expect(isAllowedOrigin(null)).toBe(false);
		expect(isAllowedOrigin(undefined as unknown as null)).toBe(false);
	});

	it('does not allow a hostname that merely contains an allowed one', () => {
		expect(isAllowedOrigin('https://localhost.evil.example')).toBe(false);
		expect(isAllowedOrigin('https://127.0.0.1.evil.example')).toBe(false);
	});
});

describe('corsHeaders', () => {
	it('echoes an allowed origin', () => {
		const h = corsHeaders('https://insertabot.io');
		expect(h['Access-Control-Allow-Origin']).toBe('https://insertabot.io');
	});

	it('omits Allow-Origin entirely for a disallowed origin', () => {
		const h = corsHeaders('https://evil.example');
		expect(h['Access-Control-Allow-Origin']).toBeUndefined();
	});

	it('never emits a wildcard', () => {
		for (const origin of [null, undefined, '*', 'https://evil.example', 'https://insertabot.io']) {
			expect(corsHeaders(origin as string | null)['Access-Control-Allow-Origin']).not.toBe('*');
		}
	});

	it('always sets Vary: Origin so caches cannot cross-serve a CORS decision', () => {
		expect(corsHeaders('https://insertabot.io').Vary).toBe('Origin');
		expect(corsHeaders('https://evil.example').Vary).toBe('Origin');
		expect(corsHeaders(null).Vary).toBe('Origin');
	});

	it('keeps the shared method/header allowances', () => {
		const h = corsHeaders(null);
		expect(h['Access-Control-Allow-Methods']).toContain('POST');
		expect(h['Access-Control-Allow-Headers']).toContain('Content-Type');
	});

	it('returns a fresh object each call, so callers cannot mutate shared state', () => {
		const a = corsHeaders('https://insertabot.io');
		a['Access-Control-Allow-Origin'] = 'https://evil.example';
		expect(corsHeaders('https://insertabot.io')['Access-Control-Allow-Origin']).toBe(
			'https://insertabot.io',
		);
	});

	it('handles a native client that sends no Origin (the Android app)', () => {
		// OkHttp sends no Origin and never consults CORS; the response is still
		// well-formed, it simply carries no Allow-Origin.
		const h = corsHeaders(null);
		expect(h['Access-Control-Allow-Origin']).toBeUndefined();
		expect(h['Access-Control-Allow-Methods']).toBeDefined();
	});
});

describe('jsonResponse', () => {
	it('serialises the body and sets the content type', async () => {
		const res = jsonResponse({ ok: true });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/json');
		expect(await res.json()).toEqual({ ok: true });
	});

	it('merges extra headers and honours the status', () => {
		const res = jsonResponse({ e: 1 }, 500, corsHeaders('https://insertabot.io'));
		expect(res.status).toBe(500);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://insertabot.io');
		expect(res.headers.get('Vary')).toBe('Origin');
	});
});

describe('errorMessage', () => {
	it('unwraps an Error', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
	});

	it('stringifies non-Error values', () => {
		expect(errorMessage('plain')).toBe('plain');
		expect(errorMessage(42)).toBe('42');
		expect(errorMessage(null)).toBe('null');
	});
});
