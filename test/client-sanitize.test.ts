import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain-JS frontend module, no type declarations by design.
import { stripPlaceholders as stripClient } from '../public/sanitize.js';
import { stripPlaceholders as stripWorker } from '../src/lib/sanitize';

/**
 * The client scrub is a safety net for history persisted before the worker-side
 * filter existed. It must agree with the worker on every case, or the same
 * message renders differently depending on which path cleaned it.
 */
describe('client/worker placeholder scrub parity', () => {
	const cases = [
		"Hello! I'm <PRESIDIO_ANONYMIZED_ENTITY_248>, a helpful AI.",
		'Ask <PRESIDIO_ANONYMIZED_ENTITY_1> about it',
		'<PRESIDIO_ENTITY_1> starts here',
		'ends here <PRESIDIO_ENTITY_1>',
		'a [ANONYMIZED_PERSON] b',
		'a {ANONYMISED_THING} b',
		'a </PRESIDIO_ANONYMIZED_ENTITY_7> b',
		'nothing to redact',
		'col1    col2    col3',
		['```python', 'def f(x):', '    if x:', '        return 1', '```'].join('\n'),
		['text <PRESIDIO_ENTITY_2> here', '```js', 'if (a) {', '    b();', '}', '```'].join('\n'),
	];

	it.each(cases)('agrees on %j', (input) => {
		expect(stripClient(input)).toBe(stripWorker(input));
	});
});

/**
 * Regression: the client scrub also ran a global `[ \t]{2,}` collapse. It was
 * guarded by a `PRESIDIO|ANONYMISED` pre-test, so it only fired on messages
 * that actually contained a placeholder — but for those messages it flattened
 * every code block in the same message.
 */
describe('client scrub preserves indentation', () => {
	it('keeps code-block indentation in a message that also has a placeholder', () => {
		const input = [
			'Here you go, <PRESIDIO_ANONYMIZED_ENTITY_9>:',
			'```python',
			'def f(x):',
			'    if x:',
			'        return 1',
			'```',
		].join('\n');

		const out = stripClient(input);
		expect(out).toContain('    if x:');
		expect(out).toContain('        return 1');
		expect(out).not.toContain('PRESIDIO');
	});

	it('is a byte-exact no-op when no placeholder is present', () => {
		const text = ['```yaml', 'a:', '  b:', '    - c', '```'].join('\n');
		expect(stripClient(text)).toBe(text);
	});

	it('tolerates empty and nullish input', () => {
		expect(stripClient('')).toBe('');
		expect(stripClient(undefined)).toBe(undefined);
	});
});
