// ── Inline markdown renderer (no external deps, line-by-line) ───────────────
//
// Extracted from index.js so the escaping and URL-sanitising logic can be unit
// tested without a DOM. Rendered output is assigned via `innerHTML`, so every
// function here is a security boundary — see escHtml/safeUrl below.

/**
 * Escape text for interpolation into HTML.
 *
 * Quotes are escaped as well as `&<>`, which matters because parseInline
 * interpolates a captured link target into an `href="…"` attribute. Escaping
 * only `&<>` (as an earlier version did) left `"` live, so a link target could
 * close the attribute and inject event handlers:
 *   [y](https://a.com" autofocus onfocus="alert(1))
 * That is defence in depth alongside safeUrl(): attribute breakout is closed
 * here, dangerous schemes are closed there.
 */
export function escHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Schemes permitted in rendered link targets. */
const SAFE_SCHEME_RE = /^(?:https?|mailto|tel):/i;

/**
 * Characters browsers strip or ignore while parsing a URL. They must be removed
 * *before* the scheme test, or `java\tscript:alert(1)` slips past an allowlist
 * that only ever sees the literal string.
 */
const URL_IGNORED_CHARS_RE = /[\u0000-\u0020\u007f-\u00a0]/g;

/** Minimal entity decode, since escHtml has already run by the time we get here. */
function decodeBasicEntities(s) {
	return s
		.replace(/&#x27;/gi, "'")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/gi, '"')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&');
}

/**
 * Characters that never legitimately appear unencoded in a link destination.
 * Their presence means the target is an injection attempt, not a URL: per
 * CommonMark a destination containing spaces must be `<…>`-wrapped or
 * percent-encoded, and quotes/angle brackets are the raw material of an
 * attribute breakout. Rejecting outright beats relying on escaping alone —
 * the payload never reaches the attribute in any form.
 */
const URL_FORBIDDEN_RE = /["'<>`\s\\]/;

/**
 * Return `url` if it is safe to use as a link target, otherwise '#'.
 *
 * Blocks `javascript:`, `data:`, `vbscript:` and friends. Protocol-relative
 * (`//host`) and same-document/relative targets are allowed; anything with an
 * explicit scheme must be in the allowlist. Model output is untrusted input
 * here — tool results from a connected MCP server flow straight into it.
 */
export function safeUrl(url) {
	// Decode first: the caller has already run escHtml over the whole string, and
	// a scheme test against `&quot;` or `java&#9;script:` would be meaningless.
	const decoded = decodeBasicEntities(String(url));

	if (URL_FORBIDDEN_RE.test(decoded)) return '#';

	const probe = decoded.replace(URL_IGNORED_CHARS_RE, '').trim();

	if (probe === '') return '#';

	// Relative, root-relative, protocol-relative, query or fragment targets have
	// no scheme of their own and inherit the page's.
	if (/^(?:[/?#]|\.{1,2}\/)/.test(probe)) return url;

	// A colon before the first path/query/fragment delimiter means an explicit
	// scheme, which must be allowlisted. `foo:bar` and `javascript:…` both land
	// here; `example.com/a:b` does not.
	const delimiter = probe.search(/[/?#]/);
	const head = delimiter === -1 ? probe : probe.slice(0, delimiter);
	if (head.includes(':')) return SAFE_SCHEME_RE.test(probe) ? url : '#';

	// Bare hostname such as `example.com/path`.
	return url;
}

export function parseInline(s) {
	return escHtml(s)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/__(.+?)__/g, '<strong>$1</strong>')
		.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
		// Underscore emphasis only at word boundaries, matching CommonMark.
		// Without the guards, identifiers like MY_CONST_NAME render as italics
		// and look like garbled foreign text.
		.replace(/(^|[\s(["'])_([^_\n]+)_(?=$|[\s)\]"'.,;:!?])/g, '$1<em>$2</em>')
		.replace(/~~(.+?)~~/g, '<del>$1</del>')
		// `href` arrives already escaped by the escHtml() call at the top of this
		// chain, so it holds no raw quote and cannot break out of the attribute.
		// Re-escaping here would double-encode it (`&quot;` → `&amp;quot;`) and
		// corrupt legitimate URLs containing `&`.
		.replace(
			/\[([^\]]+)\]\(([^)]+)\)/g,
			(_m, text, href) =>
				`<a href="${safeUrl(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`,
		);
}

export function renderMarkdown(text) {
	const div = document.createElement('div');
	div.className = 'bubble-content';

	function flushPara(lines) {
		if (!lines.length) return;
		const p = document.createElement('p');
		p.innerHTML = parseInline(lines.join(' '));
		div.appendChild(p);
	}

	function flushList(items, ordered) {
		if (!items.length) return;
		const list = document.createElement(ordered ? 'ol' : 'ul');
		for (const item of items) {
			const li = document.createElement('li');
			li.innerHTML = parseInline(item);
			list.appendChild(li);
		}
		div.appendChild(list);
	}

	const lines = text.split('\n');
	let i = 0;
	let paraLines = [];
	let listItems = [];
	let listOrdered = false;

	function commitPending() {
		if (listItems.length) {
			flushList(listItems, listOrdered);
			listItems = [];
		}
		if (paraLines.length) {
			flushPara(paraLines);
			paraLines = [];
		}
	}

	while (i < lines.length) {
		const line = lines[i];

		if (line.startsWith('```')) {
			commitPending();
			const pre = document.createElement('pre');
			const code = document.createElement('code');
			const codeLines = [];
			i++;
			while (i < lines.length && !lines[i].startsWith('```')) {
				codeLines.push(lines[i]);
				i++;
			}
			// textContent, not innerHTML — code blocks are never markup.
			code.textContent = codeLines.join('\n');
			pre.appendChild(code);
			div.appendChild(pre);
			i++;
			continue;
		}

		const hm = line.match(/^(#{1,3})\s+(.*)/);
		if (hm) {
			commitPending();
			const el = document.createElement(`h${hm[1].length}`);
			el.innerHTML = parseInline(hm[2]);
			div.appendChild(el);
			i++;
			continue;
		}

		if (/^[-*_]{3,}\s*$/.test(line)) {
			commitPending();
			div.appendChild(document.createElement('hr'));
			i++;
			continue;
		}

		if (line.startsWith('> ')) {
			commitPending();
			const bq = document.createElement('blockquote');
			const bqLines = [];
			while (i < lines.length && lines[i].startsWith('> ')) {
				bqLines.push(lines[i].slice(2));
				i++;
			}
			bq.innerHTML = parseInline(bqLines.join(' '));
			div.appendChild(bq);
			continue;
		}

		if (line.trim() === '') {
			commitPending();
			i++;
			continue;
		}

		const ulm = line.match(/^[-*+]\s+(.*)/);
		if (ulm) {
			if (paraLines.length) {
				flushPara(paraLines);
				paraLines = [];
			}
			if (listItems.length && listOrdered) {
				flushList(listItems, true);
				listItems = [];
			}
			listOrdered = false;
			listItems.push(ulm[1]);
			i++;
			continue;
		}

		const olm = line.match(/^\d+\.\s+(.*)/);
		if (olm) {
			if (paraLines.length) {
				flushPara(paraLines);
				paraLines = [];
			}
			if (listItems.length && !listOrdered) {
				flushList(listItems, false);
				listItems = [];
			}
			listOrdered = true;
			listItems.push(olm[1]);
			i++;
			continue;
		}

		if (listItems.length) {
			flushList(listItems, listOrdered);
			listItems = [];
		}
		paraLines.push(line);
		i++;
	}

	commitPending();
	return div;
}
