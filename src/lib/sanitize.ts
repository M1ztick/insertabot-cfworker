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
 */

/** Keywords that identify an anonymizer placeholder. */
const PLACEHOLDER_KEYWORDS = ['PRESIDIO', 'ANONYMIZED', 'ANONYMISED'] as const;

/**
 * Matches a complete placeholder in either bracket style:
 *   <PRESIDIO_ANONYMIZED_ENTITY_248>   </PRESIDIO_ANONYMIZED_ENTITY_248>
 *   [PRESIDIO_ANONYMIZED_ENTITY_248]   {ANONYMIZED_PERSON}
 */
const PLACEHOLDER_RE =
	/[<[{]\s*\/?\s*(?:PRESIDIO|ANONYMI[SZ]ED)[A-Z0-9_\s-]*[>\]}]/gi;

/**
 * Longest fragment we will hold back waiting for a placeholder to complete.
 * Bounds worst-case latency if the model emits a lone `<` and never closes it.
 */
const MAX_HOLDBACK = 64;

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

/** Tidy up whitespace/punctuation left behind after removing a placeholder. */
function tidy(text: string): string {
	return text
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/[ \t]+([,.;:!?])/g, '$1');
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
			let text = carry + chunk;
			carry = '';

			text = text.replace(PLACEHOLDER_RE, '');

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
			// preceded by a space ("I'm <PRESIDIO_…>, a helpful…"); once it is
			// removed that space sits directly before the following comma. tidy()
			// can only drop it if the space and the comma are in the same buffer,
			// so the space must not be emitted until the next chunk arrives.
			const wsMatch = /[ \t]+$/.exec(text);
			if (wsMatch) {
				carry = wsMatch[0] + carry;
				text = text.slice(0, wsMatch.index);
			}

			return tidy(text);
		},

		flush(): string {
			const rest = tidy(carry.replace(PLACEHOLDER_RE, ''));
			carry = '';
			return rest;
		},
	};
}

/**
 * One-shot variant for non-streaming text (persisted history, tool output…).
 */
export function stripPlaceholders(text: string): string {
	return tidy(text.replace(PLACEHOLDER_RE, ''));
}
