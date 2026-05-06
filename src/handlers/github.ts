/**
 * Direct GitHub MCP tool handler
 * Exposes GitHub operations as an HTTP API in addition to the MCP tool-calling path.
 */

import { jsonResponse, corsHeaders } from '../lib/utils';

export async function handleGithub(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders() });
	}
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 });
	}

	const { action, params } = (await request.json()) as {
		action: string;
		params: Record<string, unknown>;
	};

	const token = env.GITHUB_TOKEN;
	if (!token) {
		return jsonResponse({ error: 'GITHUB_TOKEN not configured' }, 500, corsHeaders());
	}

	try {
		switch (action) {
			case 'repo_info':
				return await repoInfo(params as { owner: string; repo: string }, token);
			case 'list_issues':
				return await listIssues(
					params as { owner: string; repo: string; state?: string; per_page?: number },
					token
				);
			// TODO: Wire more direct actions as needed:
			// case 'create_pull_request': ...
			// case 'push_files': ...
			default:
				return jsonResponse({ error: `Unknown action: ${action}` }, 400, corsHeaders());
		}
	} catch (err) {
		console.error('GitHub handler error:', err);
		return jsonResponse({ error: (err as Error).message }, 500, corsHeaders());
	}
}

async function repoInfo(
	{ owner, repo }: { owner: string; repo: string },
	token: string
): Promise<Response> {
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'insertabot-cfworker',
		},
	});

	if (!res.ok) return jsonResponse({ error: res.statusText }, res.status, corsHeaders());
	return jsonResponse(await res.json(), 200, corsHeaders());
}

async function listIssues(
	params: { owner: string; repo: string; state?: string; per_page?: number },
	token: string
): Promise<Response> {
	const url = new URL(`https://api.github.com/repos/${params.owner}/${params.repo}/issues`);
	url.searchParams.set('state', params.state ?? 'open');
	url.searchParams.set('per_page', String(params.per_page ?? 10));

	const res = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'insertabot-cfworker',
		},
	});

	if (!res.ok) return jsonResponse({ error: res.statusText }, res.status, corsHeaders());
	return jsonResponse(await res.json(), 200, corsHeaders());
}
