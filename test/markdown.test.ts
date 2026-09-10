import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain-JS frontend module, no type declarations by design.
import { escHtml, parseInline, safeUrl } from '../public/markdown.js';

describe('escHtml', () => {
	it('escapes the five characters that matter inside an attribute', () => {
		expect(escHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
	});

	it('escapes & first so entities are not double-mangled', () => {
		expect(escHtml('&lt;')).toBe('&amp;lt;');
	});
});

/**
 * Regression: parseInline escaped only `&<>` and interpolated the raw link
 * target into `href="$2"`, so a quote in the target closed the attribute and
 * injected event handlers. Model output is untrusted — MCP tool results flow
 * straight into this renderer.
 */
describe('safeUrl', () => {
	it.each([
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		'  javascript:alert(1)',
		'java\tscript:alert(1)',
		'java\nscript:alert(1)',
		'jav\u0000ascript:alert(1)',
		'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
		'vbscript:msgbox(1)',
		'file:///etc/passwd',
	])('rejects dangerous target %j', (url) => {
		expect(safeUrl(url)).toBe('#');
	});

	it.each([
		'https://example.com/a',
		'http://example.com',
		'HTTPS://EXAMPLE.COM',
		'mailto:a@b.com',
		'tel:+15551234',
	])('allows safe absolute target %j', (url) => {
		expect(safeUrl(url)).toBe(url);
	});

	it.each(['/root/path', './rel', '../up', '#anchor', '?q=1', '//cdn.example.com/x', 'example.com/path'])(
		'allows schemeless target %j',
		(url) => {
			expect(safeUrl(url)).toBe(url);
		},
	);

	it('does not mistake a colon in a path for a scheme', () => {
		expect(safeUrl('example.com/a:b')).toBe('example.com/a:b');
	});

	it('rejects an empty or whitespace-only target', () => {
		expect(safeUrl('')).toBe('#');
		expect(safeUrl('   ')).toBe('#');
	});
});

describe('parseInline link XSS (regression)', () => {
	/** Attributes the renderer itself emits; anything else is injected. */
	const ALLOWED_ATTRS = new Set(['href', 'target', 'rel']);

	/** Every `name=` inside the rendered `<a …>` tag. */
	function tagAttrs(html: string): string[] {
		const tag = /<a\s([^>]*)>/.exec(html);
		return tag ? [...tag[1].matchAll(/([a-zA-Z-]+)\s*=/g)].map((m) => m[1].toLowerCase()) : [];
	}

	it('neutralises attribute breakout via a double quote', () => {
		const out = parseInline('[x](" onmouseover="alert(1)) rest');
		expect(tagAttrs(out).every((a) => ALLOWED_ATTRS.has(a))).toBe(true);
		expect(out).toContain('href="#"');
	});

	it('neutralises the autofocus/onfocus breakout payload', () => {
		const out = parseInline('[y](https://a.com" autofocus onfocus="alert(1))');
		expect(tagAttrs(out).every((a) => ALLOWED_ATTRS.has(a))).toBe(true);
		expect(out).toContain('href="#"');
	});

	it('rewrites a javascript: target to #', () => {
		const out = parseInline('[click](javascript:alert(document.domain))');
		expect(out).not.toContain('javascript:');
		expect(out).toContain('href="#"');
	});

	it('neutralises a single-quote breakout attempt', () => {
		const out = parseInline("[z](' onclick='alert(1))");
		expect(tagAttrs(out).every((a) => ALLOWED_ATTRS.has(a))).toBe(true);
		expect(out).toContain('href="#"');
	});

	it('emits no event-handler attribute for any known payload', () => {
		const payloads = [
			'[a](" onmouseover="alert(1))',
			"[b](' onclick='alert(1))",
			'[c](https://x.com" autofocus onfocus="alert(1))',
			'[d](javascript:alert(1))',
			'[e](JAVASCRIPT:alert(1))',
			'[f](data:text/html,<script>alert(1)</script>)',
		];
		for (const p of payloads) {
			const out = parseInline(p);
			expect(out, p).not.toMatch(/\bon[a-z]+\s*=/i);
			expect(out, p).not.toMatch(/javascript:/i);
		}
	});

	it('still renders a legitimate link correctly', () => {
		expect(parseInline('[Docs](https://example.com/docs)')).toBe(
			'<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">Docs</a>',
		);
	});

	it('keeps rel/target hardening on every rendered link', () => {
		const out = parseInline('[a](https://example.com)');
		expect(out).toContain('rel="noopener noreferrer"');
		expect(out).toContain('target="_blank"');
	});

	it('escapes raw HTML in surrounding text', () => {
		expect(parseInline('<img src=x onerror=alert(1)>')).not.toContain('<img');
	});
});

describe('parseInline formatting still works', () => {
	it('renders bold, italic, code, strike', () => {
		expect(parseInline('**b**')).toBe('<strong>b</strong>');
		expect(parseInline('*i*')).toBe('<em>i</em>');
		expect(parseInline('`c`')).toBe('<code>c</code>');
		expect(parseInline('~~s~~')).toBe('<del>s</del>');
	});

	it('does not italicise snake_case identifiers', () => {
		expect(parseInline('MY_CONST_NAME')).toBe('MY_CONST_NAME');
	});

	it('escapes markup inside inline code', () => {
		expect(parseInline('`<script>`')).toBe('<code>&lt;script&gt;</code>');
	});
});
