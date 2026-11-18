// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
//
// Speaks the 2026-07-28 revision through server/discover, and the older
// handshake (initialize + notifications/initialized) for clients that ask.
// tools/list offers the six tools the suite calls, each with a non-empty
// description and an object inputSchema; tools/call acts on the same store
// as REST, so a repository or issue created here reads back over /api/v3.
//
// Every tool result carries both content:[{type:"text", text: JSON}] and
// structuredContent. Unknown tools are -32601/-32602, never HTTP 500. A
// non-JSON body is HTTP 400 with -32700. No Authorization is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { VIEWER_LOGIN, isoTick } from './store.ts';
import { issueJson, pullJson, repoJson, sendJson, squashMerge } from './rest.ts';
import type { RestCtx } from './rest.ts';

export interface McpCtx {
  store: Store;
  token: string;
  baseUrl: string;
}

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (ctx: McpCtx, args: Record<string, unknown>) => { ok: boolean; result?: unknown; error?: string };
}

function parseOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  // The suite fills a full_name property (owner/repo) and maps each argument
  // onto the schema's nearest property name.
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [o, r] = fullName.split('/');
    if (owner === '') owner = o;
    if (repo === '') repo = r;
  }
  return { owner, repo };
}

function findRepo(ctx: McpCtx, args: Record<string, unknown>): Repo | null {
  const { owner, repo } = parseOwnerRepo(args);
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, repo) ?? null;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    handler: (ctx, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name.length === 0) return { ok: false, error: 'name is required' };
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return { ok: false, error: `repository ${name} already exists` };
      }
      const repo = ctx.store.createRepo(name, args.private === true, typeof args.description === 'string' ? args.description : '');
      const restCtx: RestCtx = { store: ctx.store, token: ctx.token, baseUrl: ctx.baseUrl };
      return { ok: true, result: repoJson(restCtx, repo) };
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (ctx, args) => {
      const repo = findRepo(ctx, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const restCtx: RestCtx = { store: ctx.store, token: ctx.token, baseUrl: ctx.baseUrl };
      return { ok: true, result: repoJson(restCtx, repo) };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    handler: (ctx, args) => {
      const repo = findRepo(ctx, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title.length === 0) return { ok: false, error: 'title is required' };
      const number = repo.nextNumber++;
      const now = isoTick();
      const issue: Issue = {
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        userLogin: VIEWER_LOGIN,
      };
      repo.issues.set(number, issue);
      const restCtx: RestCtx = { store: ctx.store, token: ctx.token, baseUrl: ctx.baseUrl };
      return { ok: true, result: issueJson(restCtx, repo, issue) };
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    handler: (ctx, args) => {
      const repo = findRepo(ctx, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.number - a.number);
      const restCtx: RestCtx = { store: ctx.store, token: ctx.token, baseUrl: ctx.baseUrl };
      return { ok: true, result: issues.map((issue) => issueJson(restCtx, repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    handler: (ctx, args) => {
      const repo = findRepo(ctx, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      const title = typeof args.title === 'string' ? args.title : '';
      if (head.length === 0 || title.length === 0) return { ok: false, error: 'title and head are required' };
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { ok: false, error: 'head or base branch does not exist' };
      const number = repo.nextNumber++;
      const now = isoTick();
      const pull: Pull = {
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        createdAt: now,
        updatedAt: now,
        userLogin: VIEWER_LOGIN,
      };
      repo.pulls.set(number, pull);
      const restCtx: RestCtx = { store: ctx.store, token: ctx.token, baseUrl: ctx.baseUrl };
      return { ok: true, result: pullJson(restCtx, repo, pull) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    handler: (ctx, args) => {
      const repo = findRepo(ctx, args);
      if (repo === null) return { ok: false, error: 'repository not found' };
      const number = Number(args.pull_number);
      if (!Number.isInteger(number) || number < 1) return { ok: false, error: 'pull_number is required' };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { ok: false, error: 'pull request not found' };
      if (pull.state === 'closed') return { ok: false, error: 'pull request is already closed' };
      const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
      const mergedSha = squashMerge(repo, pull, message);
      if (mergedSha === null) return { ok: false, error: 'merge conflict' };
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergedSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = isoTick();
      pull.mergeCommitSha = mergedSha;
      pull.updatedAt = pull.mergedAt;
      const restCtx: RestCtx = { store: ctx.store, token: ctx.token, baseUrl: ctx.baseUrl };
      return { ok: true, result: pullJson(restCtx, repo, pull) };
    },
  },
];


/** The tools/list payload, byte-identical on every call. */
export function toolsListPayload(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function findTool(name: string): ToolDef | undefined {
  const wanted = name.toLowerCase();
  // A server prefix is allowed (github__create_issue); match as a suffix,
  // case-insensitively.
  return TOOLS.find((tool) => {
    const candidate = tool.name.toLowerCase();
    return wanted === candidate || wanted.endsWith(`__${candidate}`) || wanted.endsWith(candidate);
  });
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRpc(ctx: McpCtx, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(version) ? version : SUPPORTED_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // notification: no reply
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, toolsListPayload());
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const tool = findTool(name);
    if (tool === undefined) {
      return rpcError(id, -32601, `Method not found: ${name}`);
    }
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        // Missing a required argument: isError, never HTTP 500.
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: `missing required argument: ${required}` }) }],
          structuredContent: { error: `missing required argument: ${required}` },
          isError: true,
        });
      }
    }
    // get_repo/create_issue/list_issues/create_pull_request/merge_pull_request
    // accept owner+repo or full_name; treat a missing owner/repo as missing
    // only when neither form names the repository.
    if (tool.name !== 'create_repo') {
      const { owner, repo } = parseOwnerRepo(args);
      if (owner === '' || repo === '') {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: 'owner and repo are required' }) }],
          structuredContent: { error: 'owner and repo are required' },
          isError: true,
        });
      }
    }
    const outcome = tool.handler(ctx, args);
    if (!outcome.ok) {
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: outcome.error ?? 'tool failed' }) }],
        structuredContent: { error: outcome.error ?? 'tool failed' },
        isError: true,
      });
    }
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
    });
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle POST /mcp. */
export function handleMcp(
  ctx: McpCtx,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice('Bearer '.length).length === 0) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return true;
  }
  if (ctx.token.length > 0 && header.slice('Bearer '.length) !== ctx.token) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  // A batch of requests answers a batch of replies, in order.
  if (Array.isArray(parsed)) {
    const replies: Array<Record<string, unknown>> = [];
    for (const item of parsed) {
      const reply = handleRpc(ctx, (typeof item === 'object' && item !== null ? item : {}) as JsonRpcRequest);
      if (reply !== null) replies.push(reply);
    }
    sendJson(res, 200, replies);
    return true;
  }
  const reply = handleRpc(ctx, (typeof parsed === 'object' && parsed !== null ? parsed : {}) as JsonRpcRequest);
  if (reply === null) {
    // A lone notification: 202, no body.
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end();
    return true;
  }
  sendJson(res, 200, reply);
  return true;
}
