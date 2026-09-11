/**
 * Strips PII-anonymizer placeholder tokens out of model output.
 *
 * Some open-weight models (Kimi K2.x among them) were pretrained on corpora
 * that had been scrubbed with Microsoft Presidio. Presidio replaces detected
 * entities with markers like `<PRESIDIO_ANONYMIZED_ENTITY_248>`, and those
 * markers survive into the weights. The model then emits them verbatim —
 * usually in exactly the spot where a proper noun belongs, e.g.
 *
 *   "Hello! I'm <PRESIDIO_ANONYMIZED_ENTITY_248>, a helpful AI assistant…"
 *
 * This is a training-data artifact, not a Cloudflare AI Gateway DLP redaction:
 * Gateway DLP reports findings via the `cf-aig-dlp` response header and its
 * block action returns HTTP 400, it never rewrites tokens inline. So the fix
 * belongs on the output stream.
 *
 * The filter is *streaming-safe*: a placeholder can be split across several
 * `text-delta` chunks, so we hold back any trailing fragment that could still
 * grow into a placeholder and re-examine it once more text arrives.
 *
 * Whitespace repair is *local*, and that is load-bearing. An earlier version
 * ran a global `replace(/[ \t]{2,}/g, ' ')` over every chunk to clean up the
 * gap a removed placeholder leaves behind. Because this filter sits on the
 * main text stream, that collapsed the indentation of every fenced code block
 * the model streamed — four-space Python bodies arrived one space deep, and
 * since the transform runs before `onFinish`, the flattened text was what got
 * persisted to history. Only the seam around an actually-removed placeholder
 * may be touched; text containing no placeholder must pass through byte-exact.
 */

/**
 * Shared pattern source, so the bare matcher and the seam matcher below cannot
 * drift apart. Matches a complete placeholder in either bracket style:
 *   <PRESIDIO_ANONYMIZED_ENTITY_248>   </PRESIDIO_ANONYMIZED_ENTITY_248>
 *   [PRESIDIO_ANONYMIZED_ENTITY_248]   {ANONYMIZED_PERSON}
 */
const PLACEHOLDER_SOURCE = '[<[{]\\s*\\/?\\s*(?:PRESIDIO|ANONYMI[SZ]ED)[A-Z0-9_\\s-]*[>\\]}]';

/**
 * The placeholder plus the horizontal whitespace hugging it. Capturing that
 * padding is what lets the seam be repaired in place instead of by a global
 * whitespace collapse — see the note above.
 */
const PLACEHOLDER_SEAM_RE = new RegExp(`([ \\t]*)(?:${PLACEHOLDER_SOURCE})([ \\t]*)`, 'gi');

/**
 * Cheap pre-test so the common case (no placeholder anywhere) skips the real
 * regex entirely. Deliberately NOT global: `.test()` on a global regex carries
 * `lastIndex` between calls and would start skipping matches.
 */
const MAYBE_PLACEHOLDER_RE = /PRESIDIO|ANONYMI[SZ]ED/i;

/** Keywords that identify an anonymizer placeholder. */
const PLACEHOLDER_KEYWORDS = ['PRESIDIO', 'ANONYMIZED', 'ANONYMISED'] as const;

/**
 * Longest fragment we will hold back waiting for a placeholder to complete.
 * Bounds worst-case latency if the model emits a lone `<` and never closes it.
 */
const MAX_HOLDBACK = 64;

/** Punctuation that must not be left orphaned behind a space. */
const SEAM_PUNCTUATION_RE = /^[,.;:!?)\]}]/;

/**
 * True when `tail` (which begins at an unclosed `<`, `[` or `{`) could still
 * turn into a placeholder once more characters arrive.
 */
function couldBecomePlaceholder(tail: string): boolean {
	const m = /^[<[{][\s/]*([A-Za-z0-9_-]*)$/.exec(tail);
	if (!m) return false;
	const body = m[1].toUpperCase();
	return PLACEHOLDER_KEYWORDS.some(
		(kw) => kw.startsWith(body) || body.startsWith(`${kw}_`),
	);
}

/** A line or buffer edge — no seam to repair, so padding is simply dropped. */
function isSeamEdge(ch: string): boolean {
	return ch === '' || ch === '\n' || ch === '\r';
}

/**
 * Remove every complete placeholder, repairing only the whitespace that was
 * directly adjacent to one. Text with no placeholder is returned untouched.
 */
function removePlaceholders(text: string): string {
	if (!MAYBE_PLACEHOLDER_RE.test(text)) return text;

	return text.replace(
		PLACEHOLDER_SEAM_RE,
		(match: string, before: string, after: string, offset: number, whole: string): string => {
			const prevChar = whole[offset - 1] ?? '';
			const nextChar = whole[offset + match.length] ?? '';

			// At the start/end of the buffer or of a line, collapsing to a space
			// would leave stray leading or trailing whitespace.
			if (isSeamEdge(prevChar) || isSeamEdge(nextChar)) return '';

			// "I'm <PRESIDIO_…>, a helpful assistant" must not become
			// "I'm , a helpful assistant".
			if (SEAM_PUNCTUATION_RE.test(nextChar)) return '';

			// Two words closed up around the placeholder keep one separator; a
			// placeholder spliced mid-word ("abc<…>def") keeps none.
			return before || after ? ' ' : '';
		},
	);
}

export interface PlaceholderFilter {
	/** Feed the next chunk; returns the text that is safe to emit now. */
	push(chunk: string): string;
	/** Emit whatever is still held back. Call once the text run has ended. */
	flush(): string;
}

export function createPlaceholderFilter(): PlaceholderFilter {
	let carry = '';

	return {
		push(chunk: string): string {
			let text = removePlaceholders(carry + chunk);
			carry = '';

			// Hold back a trailing fragment that might still complete.
			const idx = Math.max(
				text.lastIndexOf('<'),
				text.lastIndexOf('['),
				text.lastIndexOf('{'),
			);
			if (idx !== -1) {
				const tail = text.slice(idx);
				if (tail.length <= MAX_HOLDBACK && couldBecomePlaceholder(tail)) {
					carry = tail;
					text = text.slice(0, idx);
				}
			}

			// Also hold back a trailing whitespace run. A placeholder is usually
			// preceded by a space ("I'm <PRESIDIO_…>, a helpful…"); the seam repair
			// can only see that space if it is still in the buffer when the
			// placeholder arrives, so it must not be emitted until the next chunk
			// resolves what follows. Nothing is lost — the run is emitted verbatim
			// on the next push (or by flush), so indentation survives intact.
			const wsMatch = /[ \t]+$/.exec(text);
			if (wsMatch) {
				carry = wsMatch[0] + carry;
				text = text.slice(0, wsMatch.index);
			}

			return text;
		},

		flush(): string {
			const rest = removePlaceholders(carry);
			carry = '';
			return rest;
		},
	};
}

/**
 * One-shot variant for non-streaming text (persisted history, tool output…).
 */
export function stripPlaceholders(text: string): string {
	return removePlaceholders(text);
}
