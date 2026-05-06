/**
 * MCP (Model Context Protocol) Client Setup
 * Manages tool definitions and dispatches tool calls to GitHub / Tavily / etc.
 */

import type { Env } from '../worker-configuration';
import type { ToolDefinition, ToolCall, Message } from '../types';
import { safeJsonParse } from './utils';

// ------------------------------------------------------------------
// Tool schema definitions
// ------------------------------------------------------------------

export const GITHUB_TOOLS: ToolDefinition[] = [
	{
		name: 'github_repo_info',
		description: 'Get information about a GitHub repository',
		parameters: {
			type: 'object',
			properties: {
				owner: { type: 'string', description: 'Repository owner (user or org)' },
				repo: { type: 'string', description: 'Repository name' },
			},
			required: ['owner', 'repo'],
		},
	},
	{
		name: 'github_list_issues',
		description: 'List open issues in a GitHub repository',
		parameters: {
			type: 'object',
			properties: {
				owner: { type: 'string' },
				repo: { type: 'string' },
				state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
				per_page: { type: 'integer', default: 10 },
			},
			required: ['owner', 'repo'],
		},
	},
	// TODO: Add more GitHub tools as you need them:
	// github_get_file_contents, github_create_pull_request, github_push_files, etc.
];

export const TAVILY_TOOLS: ToolDefinition[] = [
	{
		name: 'tavily_search',
		description: 'Search the web for current information',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				max_results: { type: 'integer', default: 5 },
				include_answer: { type: 'boolean', default: true },
			},
			required: ['query'],
		},
	},
];

/** All available tools */
export function allTools(): ToolDefinition[] {
	return [...GITHUB_TOOLS, ...TAVILY_TOOLS];
}

// ------------------------------------------------------------------
// Tool execution dispatcher
// ------------------------------------------------------------------

export interface ToolResult {
	tool_call_id: string;
	role: 'tool';
	content: string;
}

export async function executeToolCalls(
	toolCalls: ToolCall[],
	env: Env
): Promise<ToolResult[]> {
	const results: ToolResult[] = [];

	for (const call of toolCalls) {
		try {
			const result = await dispatchSingleTool(call, env);
			results.push(result);
		} catch (err) {
			results.push({
				tool_call_id: call.id,
				role: 'tool',
				content: `Error executing ${call.function.name}: ${(err as Error).message}`,
			});
		}
	}

	return results;
}

async function dispatchSingleTool(call: ToolCall, env: Env): Promise<ToolResult> {
	const args = safeJsonParse<Record<string, unknown>>(call.function.arguments, {});

	switch (call.function.name) {
		case 'github_repo_info':
			return {
				tool_call_id: call.id,
				role: 'tool',
				content: await githubRepoInfo(args as { owner: string; repo: string }, env),
			};
		case 'github_list_issues':
			return {
				tool_call_id: call.id,
				role: 'tool',
				content: await githubListIssues(
					args as { owner: string; repo: string; state?: string; per_page?: number },
					env
				),
			};
		case 'tavily_search':
			return {
				tool_call_id: call.id,
				role: 'tool',
				content: await tavilySearch(
					args as { query: string; max_results?: number; include_answer?: boolean },
					env
				),
			};
		default:
			throw new Error(`Unknown tool: ${call.function.name}`);
	}
}

// ------------------------------------------------------------------
// GitHub implementations
// ------------------------------------------------------------------

async function githubRepoInfo(
	{ owner, repo }: { owner: string; repo: string },
	env: Env
): Promise<string> {
	const token = env.GITHUB_TOKEN;
	if (!token) throw new Error('GITHUB_TOKEN not configured');

	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'insertabot-cfworker',
		},
	});

	if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
	const data = (await res.json()) as Record<string, unknown>;

	return JSON.stringify({
		name: data.full_name,
		description: data.description,
		stars: data.stargazers_count,
		language: data.language,
		open_issues: data.open_issues_count,
		updated_at: data.updated_at,
	});
}

async function githubListIssues(
	{
		owner,
		repo,
		state = 'open',
		per_page = 10,
	}: {
		owner: string;
		repo: string;
		state?: string;
		per_page?: number;
	},
	env: Env
): Promise<string> {
	const token = env.GITHUB_TOKEN;
	if (!token) throw new Error('GITHUB_TOKEN not configured');

	const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
	url.searchParams.set('state', state);
	url.searchParams.set('per_page', String(per_page));

	const res = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'insertabot-cfworker',
		},
	});

	if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
	const data = (await res.json()) as Array<Record<string, unknown>>;

	const issues = data.map((i) => ({
		number: i.number,
		title: i.title,
		state: i.state,
		url: i.html_url,
	}));

	return JSON.stringify(issues);
}

// ------------------------------------------------------------------
// Tavily implementation
// ------------------------------------------------------------------

async function tavilySearch(
	{
		query,
		max_results = 5,
		include_answer = true,
	}: {
		query: string;
		max_results?: number;
		include_answer?: boolean;
	},
	env: Env
): Promise<string> {
	const key = env.TAVILY_API_KEY;
	if (!key) throw new Error('TAVILY_API_KEY not configured');

	const res = await fetch('https://api.tavily.com/search', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			api_key: key,
			query,
			max_results,
			include_answer,
		}),
	});

	if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
	const data = await res.json();

	return JSON.stringify(data);
}
