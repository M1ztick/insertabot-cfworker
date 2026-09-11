// ── Anonymizer placeholder scrub (client-side safety net) ───────────────────
//
// The worker already strips these from the stream (src/lib/sanitize.ts), but
// messages persisted before that fix — and any future model that leaks a new
// variant — get cleaned here too.
//
// This mirrors the seam-local repair strategy in src/lib/sanitize.ts, and for
// the same reason: a global `[ \t]{2,}` collapse would flatten the indentation
// of every fenced code block in the message. Keep the two in sync; see
// test/client-sanitize.test.ts.

const PLACEHOLDER_SOURCE = '[<[{]\\s*\\/?\\s*(?:PRESIDIO|ANONYMI[SZ]ED)[A-Z0-9_\\s-]*[>\\]}]';
const PLACEHOLDER_SEAM_RE = new RegExp(`([ \\t]*)(?:${PLACEHOLDER_SOURCE})([ \\t]*)`, 'gi');

/** Cheap pre-test; deliberately non-global so `.test()` keeps no lastIndex. */
const MAYBE_PLACEHOLDER_RE = /PRESIDIO|ANONYMI[SZ]ED/i;

const SEAM_PUNCTUATION_RE = /^[,.;:!?)\]}]/;

function isSeamEdge(ch) {
	return ch === '' || ch === '\n' || ch === '\r';
}

export function stripPlaceholders(text) {
	if (!text || !MAYBE_PLACEHOLDER_RE.test(text)) return text;

	return text.replace(PLACEHOLDER_SEAM_RE, (match, before, after, offset, whole) => {
		const prevChar = whole[offset - 1] ?? '';
		const nextChar = whole[offset + match.length] ?? '';
		if (isSeamEdge(prevChar) || isSeamEdge(nextChar)) return '';
		if (SEAM_PUNCTUATION_RE.test(nextChar)) return '';
		return before || after ? ' ' : '';
	});
}
