import { describe, it, expect } from 'vitest';
import { errorSummary, safeUrl } from '../src/lib/redact';

describe('safeUrl', () => {
	it('drops query strings that carry API keys', () => {
		expect(safeUrl('https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-secret')).toBe('https://mcp.tavily.com/mcp/');
		expect(safeUrl('https://mcp.exa.ai/mcp?exaApiKey=abc&enabledTools=x')).toBe('https://mcp.exa.ai/mcp');
	});

	it('drops credentials and fragments but keeps host and path', () => {
		expect(safeUrl('https://user:pw@example.com:8443/a/b?c=d#e')).toBe('https://example.com:8443/a/b');
	});

	it('does not echo unparseable input', () => {
		expect(safeUrl('not a url with key=secret')).toBe('[invalid url]');
	});
});

describe('errorSummary', () => {
	it('never includes the request body of an AI SDK call error', () => {
		const err = Object.assign(new Error('Bad request'), {
			name: 'AI_APICallError',
			statusCode: 400,
			requestBodyValues: { messages: [{ role: 'user', content: 'my private question' }] },
			responseBody: '{"echo":"my private question"}',
		});
		const line = errorSummary(err);
		expect(line).toBe('AI_APICallError(HTTP 400): Bad request');
		expect(line).not.toContain('private');
	});

	it('reduces URLs inside messages', () => {
		const line = errorSummary(new Error('fetch failed for https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-secret'));
		expect(line).toContain('https://mcp.tavily.com/mcp/');
		expect(line).not.toContain('tvly-secret');
	});

	it('bounds long messages and copes with non-errors', () => {
		expect(errorSummary(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(310);
		expect(errorSummary(undefined)).toBe('unknown error');
		expect(errorSummary('plain string')).toBe('plain string');
		expect(errorSummary({})).toBe('Error');
	});
});
