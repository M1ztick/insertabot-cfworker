import { describe, it, expect } from 'vitest';
import { createPlaceholderFilter, stripPlaceholders } from '../src/lib/sanitize';

/** Push `text` through the filter in fixed-size chunks, as a stream would. */
function streamThrough(text: string, chunkSize: number): string {
	const filter = createPlaceholderFilter();
	let out = '';
	for (let i = 0; i < text.length; i += chunkSize) {
		out += filter.push(text.slice(i, i + chunkSize));
	}
	return out + filter.flush();
}

describe('stripPlaceholders', () => {
	it('removes a placeholder and the space before it when punctuation follows', () => {
		expect(stripPlaceholders("Hello! I'm <PRESIDIO_ANONYMIZED_ENTITY_248>, a helpful AI.")).toBe(
			"Hello! I'm, a helpful AI.",
		);
	});

	it('leaves exactly one space when a placeholder sits between two words', () => {
		expect(stripPlaceholders('Ask <PRESIDIO_ANONYMIZED_ENTITY_1> about it')).toBe('Ask about it');
	});

	it('does not leave leading or trailing whitespace at buffer edges', () => {
		expect(stripPlaceholders('<PRESIDIO_ENTITY_1> starts here')).toBe('starts here');
		expect(stripPlaceholders('ends here <PRESIDIO_ENTITY_1>')).toBe('ends here');
	});

	it('handles every bracket style and the closing-tag form', () => {
		expect(stripPlaceholders('a [ANONYMIZED_PERSON] b')).toBe('a b');
		expect(stripPlaceholders('a {ANONYMISED_THING} b')).toBe('a b');
		expect(stripPlaceholders('a </PRESIDIO_ANONYMIZED_ENTITY_7> b')).toBe('a b');
	});

	it('is a no-op on text containing no placeholder', () => {
		const text = 'Nothing to redact here.';
		expect(stripPlaceholders(text)).toBe(text);
	});
});

/**
 * Regression: `tidy()` used to run a global `[ \t]{2,}` collapse over the whole
 * stream, which flattened the indentation of every fenced code block the model
 * emitted — and because the transform runs before `onFinish`, the mangled text
 * was persisted to history too.
 */
describe('indentation preservation (regression)', () => {
	const python = ['```python', 'def f(x):', '    if x:', '        return 1', '    return 0', '```'].join('\n');

	it('preserves indentation in a one-shot strip', () => {
		expect(stripPlaceholders(python)).toBe(python);
	});

	it.each([1, 2, 3, 5, 7, 13, 64])('preserves indentation when streamed in %i-char chunks', (size) => {
		expect(streamThrough(python, size)).toBe(python);
	});

	it('preserves runs of significant whitespace outside code blocks', () => {
		const text = 'col1    col2    col3';
		expect(stripPlaceholders(text)).toBe(text);
		expect(streamThrough(text, 3)).toBe(text);
	});

	it('preserves a deeply indented YAML block streamed in small chunks', () => {
		const yaml = ['services:', '  web:', '    ports:', '      - "8787:8787"'].join('\n');
		expect(streamThrough(yaml, 4)).toBe(yaml);
	});
});

describe('streaming placeholder removal', () => {
	const input = "Hi, I'm <PRESIDIO_ANONYMIZED_ENTITY_248>, your assistant.";
	const expected = "Hi, I'm, your assistant.";

	it.each([1, 2, 3, 4, 8, 16, 128])('strips a placeholder split across %i-char chunks', (size) => {
		expect(streamThrough(input, size)).toBe(expected);
	});

	it('emits a held-back fragment that never became a placeholder', () => {
		const filter = createPlaceholderFilter();
		// "<PRE" looks like the start of a placeholder and is held back...
		expect(filter.push('see <PRE')).toBe('see');
		// ...but the run ends, so it must still be emitted rather than swallowed.
		expect(filter.flush()).toBe(' <PRE');
	});

	it('passes through unrelated angle brackets and braces', () => {
		const text = 'use <div> and {"a": 1} and array[0]';
		expect(streamThrough(text, 5)).toBe(text);
	});

	it('flushes cleanly when a placeholder ends the stream', () => {
		const filter = createPlaceholderFilter();
		const out = filter.push('done <PRESIDIO_ENTITY_9') + filter.push('9>');
		expect(out + filter.flush()).toBe('done');
	});
});
