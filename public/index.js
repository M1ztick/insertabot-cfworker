// ── Config ──────────────────────────────────────────────────────────────────
const EMPTY_TITLE = 'InsertaBot';
const EMPTY_SUBTITLE =
	'Your AI web presence assistant. Ask anything, attach images, or let me handle tasks for you.';
const MAX_RETRIES = 5;
const MAX_RECONNECT_DELAY_MS = 16000;
const STREAM_RENDER_INTERVAL_MS = 80;
const MAX_IMAGE_DIMENSION = 1024;
const MAX_IMAGE_QUALITY = 0.85;
const MAX_PENDING_IMAGES = 4;
const RPC_TIMEOUT_MS = 15000;

// ── Plan + API key resolution ───────────────────────────────────────────────
// Priority: URL param ?plan= / ?key= → <meta> tags → demo defaults.
const IB_PARAMS = (function resolvePlanParams() {
	const params = new URLSearchParams(location.search);
	const planMeta = document.querySelector('meta[name="ib-plan"]');
	const keyMeta = document.querySelector('meta[name="ib-api-key"]');

	const VALID_PLANS = ['demo', 'light', 'plus', 'agent'];
	const plan = (() => {
		const p = params.get('plan') || planMeta?.content || 'agent';
		return VALID_PLANS.includes(p) ? p : 'agent';
	})();
	const apiKey = params.get('key') || keyMeta?.content || null;

	const PLAN_FEATURES = {
		demo: { images: true, mcp: true },
		light: { images: false, mcp: false },
		plus: { images: true, mcp: false },
		agent: { images: true, mcp: true },
	};
	const features = PLAN_FEATURES[plan] || PLAN_FEATURES.demo;

	return { plan, apiKey, features };
})();

// ── Inline markdown renderer (no external deps, line-by-line) ─────────────────
function renderMarkdown(text) {
	const div = document.createElement('div');
	div.className = 'bubble-content';

	function escHtml(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function parseInline(s) {
		return escHtml(s)
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
			.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
			.replace(/__(.+?)__/g, '<strong>$1</strong>')
			.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
			.replace(/_([^_\n]+)_/g, '<em>$1</em>')
			.replace(/~~(.+?)~~/g, '<del>$1</del>')
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
	}

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
				codeLines.push(escHtml(lines[i]));
				i++;
			}
			code.innerHTML = codeLines.join('\n');
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

// ── DOM refs ─────────────────────────────────────────────────────────────────
const msgList = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const attachBtn = document.getElementById('attach');
const fileInputEl = document.getElementById('file-input');
const previewStrip = document.getElementById('preview-strip');
const newChatBtn = document.getElementById('new-chat');
const dot = document.getElementById('dot');
const statusTxt = document.getElementById('status-text');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const reconnectBtn = document.createElement('button');

reconnectBtn.className = 'btn-ghost';
reconnectBtn.textContent = 'Reconnect';
reconnectBtn.style.display = 'none';
reconnectBtn.addEventListener('click', () => {
	retryCount = 0;
	reconnectBtn.style.display = 'none';
	connect();
});

// ── Session / state ─────────────────────────────────────────────────────────
let instanceId = localStorage.getItem('ib_instance');
if (!instanceId) {
	instanceId = crypto.randomUUID();
	localStorage.setItem('ib_instance', instanceId);
}

let messages = [];
let pendingImages = [];
let streaming = null;
let busy = false;
let ws = null;
let retryDelay = 1000;
let retryCount = 0;
let addonsOpen = false;
const pendingRpc = new Map();
let renderFrame = 0;

// ── Empty state ─────────────────────────────────────────────────────────────
function buildEmptyState() {
	const div = document.createElement('div');
	div.className = 'empty-state';
	div.id = 'empty';
	div.innerHTML = `<h2>${EMPTY_TITLE}</h2><p>${EMPTY_SUBTITLE}</p>`;
	return div;
}

function showEmpty() {
	if (!document.getElementById('empty')) {
		msgList.appendChild(buildEmptyState());
	}
}

function hideEmpty() {
	const el = document.getElementById('empty');
	if (el) el.remove();
}

// ── UI helpers ──────────────────────────────────────────────────────────────
function setConnected(yes) {
	dot.className = 'dot' + (yes ? ' on' : '');
	statusTxt.textContent = yes ? 'Connected' : 'Reconnecting…';
	inputEl.disabled = !yes || busy;
	sendBtn.disabled = !yes || busy;
	attachBtn.disabled = !yes || busy;
	reconnectBtn.style.display = yes || retryCount < MAX_RETRIES ? 'none' : '';
}

function setBusy(yes) {
	busy = yes;
	inputEl.disabled = yes;
	sendBtn.disabled = yes;
	attachBtn.disabled = yes;
}

function scrollBottom() {
	msgList.scrollTop = msgList.scrollHeight;
}

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function addRow(role, id) {
	hideEmpty();
	const row = document.createElement('div');
	row.className = `msg-row ${role}`;
	row.dataset.id = id;
	const avatar = document.createElement('div');
	avatar.className = 'avatar';
	avatar.textContent = role === 'user' ? 'You' : 'AI';
	const bubble = document.createElement('div');
	bubble.className = 'bubble';
	row.appendChild(avatar);
	row.appendChild(bubble);
	msgList.appendChild(row);
	scrollBottom();
	return bubble;
}

function extractText(msg) {
	if (Array.isArray(msg.parts)) {
		const txt = msg.parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text)
			.join('');
		if (txt) return txt;
	}
	if (typeof msg.content === 'string') return msg.content;
	return '';
}

function setBubbleContent(bubbleEl, msg) {
	bubbleEl.innerHTML = '';
	const text = extractText(msg);
	if (text) {
		if (msg.role === 'assistant') {
			bubbleEl.appendChild(renderMarkdown(text));
		} else {
			const span = document.createElement('span');
			span.textContent = text;
			bubbleEl.appendChild(span);
		}
	}
	const fileParts = Array.isArray(msg.parts) ? msg.parts.filter((p) => p.type === 'file') : [];
	for (const fp of fileParts) {
		const img = document.createElement('img');
		img.src = fp.url;
		img.className = 'msg-img';
		img.alt = fp.filename ?? 'image';
		img.addEventListener('click', () => openLightbox(fp.url));
		bubbleEl.appendChild(img);
	}
}

function addToolPill(name) {
	if (!streaming) return;
	const pill = document.createElement('div');
	pill.className = 'tool-pill';
	pill.textContent = name;
	streaming.bubbleEl.appendChild(pill);
	scrollBottom();
}

function renderAll() {
	msgList.innerHTML = '';
	if (messages.length === 0) {
		showEmpty();
		return;
	}
	for (const m of messages) {
		const bubble = addRow(m.role, m.id);
		setBubbleContent(bubble, m);
	}
	scrollBottom();
}

// ── Lightbox ─────────────────────────────────────────────────────────────────
function openLightbox(src) {
	lightboxImg.src = src;
	lightbox.classList.add('open');
}
lightbox.addEventListener('click', () => lightbox.classList.remove('open'));

// ── Add-ons panel ─────────────────────────────────────────────────────────────
function toggleAddons() {
	addonsOpen = !addonsOpen;
	document.getElementById('addons-backdrop').classList.toggle('open', addonsOpen);
	document.getElementById('addons-panel').classList.toggle('open', addonsOpen);
}

function callRpc(method, args) {
	return new Promise((resolve, reject) => {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			reject(new Error('Not connected'));
			return;
		}
		const id = crypto.randomUUID();
		pendingRpc.set(id, { resolve, reject });
		ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
		setTimeout(() => {
			if (pendingRpc.has(id)) {
				pendingRpc.delete(id);
				reject(new Error('Request timed out'));
			}
		}, RPC_TIMEOUT_MS);
	});
}

function dotClass(state) {
	if (state === 'ready') return 'ready';
	if (state === 'connecting') return 'connecting';
	if (state === 'failed') return 'failed';
	if (state === 'authenticating') return 'authenticating';
	return 'other';
}

function renderAddons(mcp) {
	if (!mcp) return;
	const serversEl = document.getElementById('addons-servers');
	const servers = mcp.servers ?? {};
	const tools = Array.isArray(mcp.tools) ? mcp.tools : [];
	const entries = Object.entries(servers);

	serversEl.innerHTML = '';
	if (entries.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'addons-empty';
		empty.textContent = 'No servers connected yet.';
		serversEl.appendChild(empty);
		return;
	}

	for (const [id, srv] of entries) {
		const serverTools = tools.filter((t) => t.serverId === id);
		const card = document.createElement('div');
		card.className = 'server-card';

		const top = document.createElement('div');
		top.className = 'server-card-top';

		const statusDot = document.createElement('span');
		statusDot.className = `server-status-dot ${dotClass(srv.state)}`;
		statusDot.title = srv.state ?? '';

		const nameEl = document.createElement('span');
		nameEl.className = 'server-name';
		nameEl.title = srv.server_url ?? '';
		nameEl.textContent = srv.name ?? id;

		const disconnectBtn = document.createElement('button');
		disconnectBtn.className = 'server-disconnect';
		disconnectBtn.textContent = 'Remove';
		disconnectBtn.addEventListener('click', async () => {
			disconnectBtn.disabled = true;
			disconnectBtn.textContent = '…';
			try {
				await callRpc('removeServer', [id]);
			} catch {}
			disconnectBtn.disabled = false;
			disconnectBtn.textContent = 'Remove';
		});

		top.appendChild(statusDot);
		top.appendChild(nameEl);
		top.appendChild(disconnectBtn);
		card.appendChild(top);

		if (srv.error) {
			const errEl = document.createElement('div');
			errEl.className = 'server-error';
			errEl.textContent = srv.error;
			card.appendChild(errEl);
		}

		if (srv.state === 'authenticating' && srv.auth_url) {
			const authLink = document.createElement('a');
			authLink.href = srv.auth_url;
			authLink.target = '_blank';
			authLink.rel = 'noopener noreferrer';
			authLink.className = 'addons-auth-link';
			authLink.textContent = 'Authorize to continue →';
			card.appendChild(authLink);
		}

		if (serverTools.length > 0) {
			const toolsEl = document.createElement('div');
			toolsEl.className = 'server-tools';
			for (const t of serverTools) {
				const chip = document.createElement('span');
				chip.className = 'tool-chip';
				chip.title = t.description ?? '';
				chip.textContent = t.name;
				toolsEl.appendChild(chip);
			}
			card.appendChild(toolsEl);
		} else if (srv.state === 'ready') {
			const toolsEl = document.createElement('div');
			toolsEl.className = 'server-tools';
			const chip = document.createElement('span');
			chip.className = 'tool-chip';
			chip.style.opacity = '0.4';
			chip.textContent = 'No tools exposed';
			toolsEl.appendChild(chip);
			card.appendChild(toolsEl);
		}

		serversEl.appendChild(card);
	}
}

async function connectServer() {
	const nameInput = document.getElementById('addons-name');
	const urlInput = document.getElementById('addons-url');
	const tokenInput = document.getElementById('addons-token');
	const errorEl = document.getElementById('addons-form-error');
	const connectBtn = document.getElementById('addons-connect-btn');

	const urlVal = urlInput.value.trim();
	if (!urlVal) {
		errorEl.textContent = 'Please enter a server URL.';
		return;
	}
	let parsedUrl;
	try {
		parsedUrl = new URL(urlVal);
	} catch {
		errorEl.textContent = "That doesn't look like a valid URL.";
		return;
	}
	const nameVal = nameInput.value.trim() || parsedUrl.hostname;
	const tokenVal = tokenInput.value.trim() || undefined;
	errorEl.textContent = '';
	connectBtn.disabled = true;
	connectBtn.textContent = 'Connecting…';
	try {
		await callRpc('addServer', [nameVal, urlVal, tokenVal]);
		nameInput.value = '';
		urlInput.value = '';
		tokenInput.value = '';
	} catch (e) {
		errorEl.textContent = e.message ?? 'Connection failed.';
	} finally {
		connectBtn.disabled = false;
		connectBtn.textContent = 'Connect';
	}
}

// ── Image compression + preview ─────────────────────────────────────────────
function resizeAndCompress(file, maxDim = MAX_IMAGE_DIMENSION, quality = MAX_IMAGE_QUALITY) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(img.src);
			const { width, height } = img;
			let targetWidth = width;
			let targetHeight = height;
			if (width > maxDim || height > maxDim) {
				const scale = maxDim / Math.max(width, height);
				targetWidth = Math.round(width * scale);
				targetHeight = Math.round(height * scale);
			}
			const canvas = document.createElement('canvas');
			canvas.width = targetWidth;
			canvas.height = targetHeight;
			const ctx = canvas.getContext('2d');
			ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
			const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
			const outQuality = file.type === 'image/png' ? undefined : quality;
			const dataUrl = canvas.toDataURL(outType, outQuality);
			resolve({ dataUrl, mimeType: outType, filename: file.name });
		};
		img.onerror = reject;
		img.src = URL.createObjectURL(file);
	});
}

function updatePreviewStrip() {
	previewStrip.innerHTML = '';
	previewStrip.style.display = pendingImages.length ? 'flex' : 'none';
	pendingImages.forEach((img, i) => {
		const wrap = document.createElement('div');
		wrap.className = 'preview-thumb';
		const imgEl = document.createElement('img');
		imgEl.src = img.dataUrl;
		imgEl.alt = img.filename;
		const rm = document.createElement('button');
		rm.className = 'preview-remove';
		rm.textContent = '×';
		rm.title = 'Remove';
		rm.addEventListener('click', () => {
			pendingImages.splice(i, 1);
			updatePreviewStrip();
		});
		wrap.appendChild(imgEl);
		wrap.appendChild(rm);
		previewStrip.appendChild(wrap);
	});
}

attachBtn.addEventListener('click', () => fileInputEl.click());

fileInputEl.addEventListener('change', async () => {
	const files = Array.from(fileInputEl.files || []);
	for (const file of files) {
		if (pendingImages.length >= MAX_PENDING_IMAGES) break;
		try {
			const compressed = await resizeAndCompress(file);
			pendingImages.push(compressed);
		} catch {}
	}
	fileInputEl.value = '';
	updatePreviewStrip();
});

// ── Streaming helpers (batched for performance) ─────────────────────────────
function startStream(msgId) {
	if (streaming) finalizeStream();
	const bubble = addRow('assistant', msgId);
	const cursor = document.createElement('span');
	cursor.className = 'cursor';
	bubble.appendChild(cursor);
	streaming = { id: msgId, bubbleEl: bubble, text: '', cursor, dirty: false };
}

function scheduleRender() {
	if (!streaming || streaming.dirty) return;
	streaming.dirty = true;
	renderFrame = requestAnimationFrame(() => {
		if (!streaming) return;
		streaming.dirty = false;
		const { bubbleEl, cursor, text } = streaming;
		bubbleEl.innerHTML = '';
		const content = renderMarkdown(text);
		bubbleEl.appendChild(content);
		bubbleEl.appendChild(cursor);
		scrollBottom();
	});
}

function appendChunk(delta) {
	if (!streaming) return;
	streaming.text += delta;
	streaming.dirty = false;
	const now = performance.now();
	const lastRender = streaming.lastRender || 0;
	// Re-render on punctuation/whitespace boundaries or after interval, to balance
	// responsiveness with DOM churn.
	const boundaryChars = /[\s\n\.,;:!?)]$/;
	if (now - lastRender > STREAM_RENDER_INTERVAL_MS || boundaryChars.test(delta)) {
		scheduleRender();
		streaming.lastRender = now;
	}
}

function finalizeStream() {
	if (!streaming) return;
	cancelAnimationFrame(renderFrame);
	const { bubbleEl, cursor, text, id } = streaming;
	if (bubbleEl.contains(cursor)) bubbleEl.removeChild(cursor);
	bubbleEl.innerHTML = '';
	bubbleEl.appendChild(renderMarkdown(text));
	if (!messages.some((m) => m.id === id)) {
		messages.push({
			id,
			role: 'assistant',
			content: text,
			parts: [{ type: 'text', text }],
			createdAt: new Date().toISOString(),
		});
	}
	streaming = null;
	setBusy(false);
}

// ── New conversation ─────────────────────────────────────────────────────────
function newConversation() {
	if (streaming) finalizeStream();
	messages = [];
	pendingImages = [];
	updatePreviewStrip();
	instanceId = crypto.randomUUID();
	localStorage.setItem('ib_instance', instanceId);
	renderAll();
	if (ws) ws.close();
}

newChatBtn.addEventListener('click', newConversation);

// ── WebSocket (with capped retries) ───────────────────────────────────────────
function connect() {
	if (retryCount >= MAX_RETRIES) {
		setConnected(false);
		statusTxt.textContent = 'Disconnected';
		reconnectBtn.style.display = '';
		console.warn(`[WS] Reached max retries (${MAX_RETRIES}); waiting for user to reconnect`);
		return;
	}

	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const keyParam = IB_PARAMS.apiKey ? `?ib_key=${encodeURIComponent(IB_PARAMS.apiKey)}` : '';
	ws = new WebSocket(`${proto}//${location.host}/agents/chat-agent/${instanceId}${keyParam}`);

	ws.onopen = () => {
		retryCount = 0;
		retryDelay = 1000;
		setConnected(true);
	};

	ws.onclose = () => {
		setConnected(false);
		finalizeStream();
		setBusy(false);
		ws = null;
		retryCount++;
		if (retryCount >= MAX_RETRIES) {
			statusTxt.textContent = 'Disconnected';
			reconnectBtn.style.display = '';
			return;
		}
		setTimeout(connect, retryDelay);
		retryDelay = Math.min(retryDelay * 2, MAX_RECONNECT_DELAY_MS);
	};

	ws.onerror = () => ws.close();

	ws.onmessage = (evt) => {
		let data;
		try {
			data = JSON.parse(evt.data);
		} catch {
			return;
		}
		onAgentMessage(data);
	};
}

function onAgentMessage(data) {
	switch (data.type) {
		case 'rpc': {
			const p = pendingRpc.get(data.id);
			if (p) {
				pendingRpc.delete(data.id);
				if (data.success) p.resolve(data.result);
				else p.reject(new Error(data.error ?? 'RPC error'));
			}
			break;
		}

		case 'cf_agent_mcp_servers':
			renderAddons(data.mcp);
			break;

		case 'cf_agent_chat_messages':
			if (Array.isArray(data.messages) && !streaming) {
				messages = data.messages;
				renderAll();
			}
			break;

		case 'cf_agent_use_chat_response': {
			const { body, done, id: reqId } = data;

			if (body) {
				let chunk;
				try {
					chunk = JSON.parse(body);
				} catch {
					break;
				}

				switch (chunk.type) {
					case 'start':
						startStream(chunk.messageId ?? reqId);
						break;
					case 'text-delta':
						if (!streaming) startStream(reqId);
						appendChunk(chunk.delta ?? chunk.textDelta ?? '');
						break;
					case 'tool-input-start':
					case 'tool-input-available':
					case 'tool-call':
						addToolPill(chunk.toolName ?? chunk.name ?? 'tool');
						break;
					case 'tool-output-available':
					case 'tool-result':
						if (!streaming) startStream(reqId);
						break;
					case 'tool-output-error':
					case 'tool-error': {
						const toolName = chunk.toolName ?? chunk.name ?? 'tool';
						const errText = chunk.errorText ?? chunk.error ?? 'tool execution failed';
						if (!streaming) startStream(reqId);
						streaming.text += `\n\n*[Tool \`${toolName}\` failed: ${errText}]*`;
						finalizeStream();
						break;
					}
					case 'finish':
						finalizeStream();
						break;
					case 'error':
						if (!streaming) startStream(reqId);
						streaming.text += `\n\n*[Error: ${chunk.errorText ?? chunk.error ?? 'unknown'}]*`;
						finalizeStream();
						break;
				}
			}

			if (done) finalizeStream();
			break;
		}

		case 'cf_agent_state':
			if (data.state?.messages && !streaming) {
				messages = data.state.messages;
				renderAll();
			}
			break;
	}
}

// ── Sending ───────────────────────────────────────────────────────────────────
function send() {
	const text = inputEl.value.trim();
	if ((!text && !pendingImages.length) || busy || !ws || ws.readyState !== WebSocket.OPEN) return;

	const parts = [];
	if (text) parts.push({ type: 'text', text });
	for (const img of pendingImages) {
		parts.push({ type: 'file', mediaType: img.mimeType, url: img.dataUrl, filename: img.filename });
	}

	const userMsg = {
		id: crypto.randomUUID(),
		role: 'user',
		content: text || ' ',
		parts,
		createdAt: new Date().toISOString(),
	};
	messages.push(userMsg);

	const bubble = addRow('user', userMsg.id);
	setBubbleContent(bubble, userMsg);
	scrollBottom();

	pendingImages = [];
	updatePreviewStrip();
	inputEl.value = '';
	inputEl.style.height = 'auto';
	setBusy(true);

	ws.send(
		JSON.stringify({
			type: 'cf_agent_use_chat_request',
			id: crypto.randomUUID(),
			init: {
				method: 'POST',
				body: JSON.stringify({ messages, trigger: 'submit-message' }),
			},
		}),
	);
}

// ── Input events ───────────────────────────────────────────────────────────
inputEl.addEventListener('input', () => {
	inputEl.style.height = 'auto';
	inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		send();
	}
});

sendBtn.addEventListener('click', send);

// ── Boot ─────────────────────────────────────────────────────────────────────
(function applyPlanUI() {
	const badge = document.getElementById('plan-badge');
	const banner = document.getElementById('demo-banner');
	const labels = {
		demo: 'Demo',
		light: 'Light',
		plus: 'Plus ✦',
		agent: 'Agent ✦✦',
	};
	if (badge) {
		badge.textContent = labels[IB_PARAMS.plan] || 'Demo';
		badge.className = `plan-badge ${IB_PARAMS.plan}`;
	}
	if (IB_PARAMS.plan === 'demo' && banner) {
		banner.classList.add('visible');
	}
	if (attachBtn) {
		attachBtn.style.display = IB_PARAMS.features.images ? '' : 'none';
	}
	const addonsBtn = document.getElementById('addons-btn');
	if (addonsBtn && !IB_PARAMS.features.mcp) {
		addonsBtn.style.display = 'none';
	}
	// Insert reconnect button into the status area for agent/demo plans
	const status = document.querySelector('.status');
	if (status) status.appendChild(reconnectBtn);
})();

document.getElementById('addons-btn').addEventListener('click', toggleAddons);
document.getElementById('addons-close').addEventListener('click', toggleAddons);
document.getElementById('addons-backdrop').addEventListener('click', toggleAddons);
document.getElementById('addons-connect-btn').addEventListener('click', connectServer);
document.getElementById('addons-url').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') connectServer();
});

showEmpty();
connect();
