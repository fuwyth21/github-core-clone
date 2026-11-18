// rest.ts — GitHub REST v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
// Auth is Bearer $MAKEFUN_SHOP_TOKEN (exact match when set); a missing or
// wrong token is 401. A repository under any owner but the viewer is 404.
// Unknown routes and missing resources are JSON 404s; a malformed JSON body
// is a 400. Deterministic: no Date.now() in any data path.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commentGlobalId,
  isoTick,
  issueGlobalId,
  nextCommitTime,
  pullGlobalId,
  repoGlobalId,
  seedLabels,
} from './store.ts';
import * as git from './git.ts';

export interface RestCtx {
  store: Store;
  token: string;
  baseUrl: string;
}

let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  requestCounter += 1;
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'X-GitHub-Request-Id': `req-${requestCounter}`,
    ...(extra ?? {}),
  });
  res.end(data);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

function checkAuth(ctx: RestCtx, req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length === 0) return false;
  if (ctx.token.length > 0) return presented === ctx.token;
  return true;
}

/** Parse a JSON request body; null when the body is empty, 'bad' when malformed. */
export function parseJsonBody(body: Buffer): unknown | 'bad' | null {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return 'bad';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// -------------------------------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------------------------------

export function repoJson(ctx: RestCtx, repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalId(repo),
    databaseId: repo.databaseId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', name: VIEWER_NAME },
    private: repo.isPrivate,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
    clone_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}.git`,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

export function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(ctx: RestCtx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue.number),
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: issue.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(ctx: RestCtx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull.number),
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    mergeable: isMergeable(repo, pull),
  };
}

// -------------------------------------------------------------------------------------------
// Git helpers for the REST surface
// -------------------------------------------------------------------------------------------

const AUTHOR = `${VIEWER_NAME} <${VIEWER_LOGIN}@example.invalid>`;

/** Create a commit object in a repo and return its oid. */
export function makeCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const time = nextCommitTime();
  const stamp = `${time} +0000`;
  const commit: git.CommitInfo = {
    tree: treeOid,
    parents,
    author: `${AUTHOR} ${stamp}`,
    committer: `${AUTHOR} ${stamp}`,
    message: message.endsWith('\n') ? message : `${message}\n`,
  };
  return git.putObject(repo, 'commit', git.serializeCommit(commit));
}

/** The tip commit oid of a branch, or null. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Commits on a branch, newest first, following first parents only. */
export function branchCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = tip;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push(cur);
    const commit = git.parseCommit(obj.data);
    cur = commit !== null && commit.parents.length > 0 ? commit.parents[0] : null;
  }
  return out;
}

/** The merge-base of two commits (the common ancestor closest to `a`). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aDepth = git.walkCommits(repo, [a], null);
  if (aDepth.has(b)) return b;
  const bWalk = git.walkCommits(repo, [b], null);
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const oid of bWalk.keys()) {
    const d = aDepth.get(oid);
    if (d !== undefined && d < bestDepth) {
      bestDepth = d;
      best = oid;
    }
  }
  return best;
}

/**
 * The file-level diff between two commits: path -> {status, oldOid, newOid}.
 * status is added / removed / modified.
 */
export function diffFiles(
  repo: Repo,
  fromCommit: string,
  toCommit: string,
): Map<string, { status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const out = new Map<string, { status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }>();
  const fromObj = repo.objects.get(fromCommit);
  const toObj = repo.objects.get(toCommit);
  const fromTree = fromObj !== undefined && fromObj.type === 'commit' ? git.parseCommit(fromObj.data)?.tree ?? null : null;
  const toTree = toObj !== undefined && toObj.type === 'commit' ? git.parseCommit(toObj.data)?.tree ?? null : null;
  const fromFiles = fromTree !== null ? git.flattenTree(repo, fromTree) : new Map<string, { mode: string; oid: string }>();
  const toFiles = toTree !== null ? git.flattenTree(repo, toTree) : new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...fromFiles.keys(), ...toFiles.keys()]);
  for (const path of paths) {
    const f = fromFiles.get(path);
    const t = toFiles.get(path);
    if (f === undefined && t !== undefined) out.set(path, { status: 'added', oldOid: null, newOid: t.oid });
    else if (f !== undefined && t === undefined) out.set(path, { status: 'removed', oldOid: f.oid, newOid: null });
    else if (f !== undefined && t !== undefined && f.oid !== t.oid) out.set(path, { status: 'modified', oldOid: f.oid, newOid: t.oid });
  }
  return out;
}

/** The current tip of a pull request's base branch (its stored baseSha is a snapshot from creation). */
export function currentBaseSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/** Would merging this pull conflict (same file changed differently on both sides)? */
export function isMergeable(repo: Repo, pull: Pull): boolean {
  const baseTip = currentBaseSha(repo, pull);
  const base = mergeBase(repo, pull.headSha, baseTip);
  if (base === null) return pull.headSha === baseTip;
  const headDiff = diffFiles(repo, base, pull.headSha);
  const baseDiff = diffFiles(repo, base, baseTip);
  for (const [path, h] of headDiff) {
    const b = baseDiff.get(path);
    if (b !== undefined && h.newOid !== b.newOid) return false;
  }
  return true;
}

/**
 * The squash-merge commit for a pull: single parent = the base branch's
 * current tip, tree = that tip's tree with the head's changes applied.
 * Returns the new commit oid, or null when the merge conflicts.
 */
export function squashMerge(repo: Repo, pull: Pull, message: string): string | null {
  const baseTip = currentBaseSha(repo, pull);
  if (!isMergeable(repo, pull)) return null;
  const base = mergeBase(repo, pull.headSha, baseTip);
  if (base === null) return null;
  const baseObj = repo.objects.get(baseTip);
  if (baseObj === undefined || baseObj.type !== 'commit') return null;
  const baseCommit = git.parseCommit(baseObj.data);
  if (baseCommit === null) return null;
  const files = git.flattenTree(repo, baseCommit.tree);
  const headDiff = diffFiles(repo, base, pull.headSha);
  for (const [path, change] of headDiff) {
    if (change.status === 'removed') files.delete(path);
    else if (change.newOid !== null) files.set(path, { mode: '100644', oid: change.newOid });
  }
  const treeOid = git.buildTreeFromFiles(repo, files);
  return makeCommit(repo, treeOid, [baseTip], message);
}

// -------------------------------------------------------------------------------------------
// Routing helpers
// -------------------------------------------------------------------------------------------

export interface RouteMatch {
  owner: string;
  repoName: string;
  rest: string[];
}

function matchRepoRoute(pathname: string): RouteMatch | null {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  // /api/v3/repos/{owner}/{repo}[/...]
  if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'repos') {
    return { owner: parts[3], repoName: parts[4], rest: parts.slice(5) };
  }
  return null;
}

function getRepoOr404(ctx: RestCtx, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    notFound(res);
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    notFound(res);
    return null;
  }
  return repo;
}

/** Parse a positive integer query value, with a default. */
function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// -------------------------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------------------------

function handleRoot(ctx: RestCtx, res: ServerResponse): void {
  sendJson(
    res,
    200,
    {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_url: `${ctx.baseUrl}/api/v3/users/{user}`,
      rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
    },
    { 'X-OAuth-Scopes': 'repo, read:org' },
  );
}

function handleMeta(res: ServerResponse): void {
  sendJson(res, 200, { installed_version: '1.0.0' });
}

function handleUser(res: ServerResponse): void {
  sendJson(res, 200, {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
    name: VIEWER_NAME,
    email: `${VIEWER_LOGIN}@example.invalid`,
    type: 'User',
  });
}

function handleListUserRepos(ctx: RestCtx, req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const repos = ctx.store.viewerRepos();
  const perPage = Math.min(queryInt(query, 'per_page', 30), 100);
  const page = queryInt(query, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const start = (page - 1) * perPage;
  const items = repos.slice(start, start + perPage).map((repo) => repoJson(ctx, repo));
  const extra: Record<string, string> = {};
  if (page < totalPages) {
    const next = new URL(`${ctx.baseUrl}/api/v3/user/repos`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    extra.Link = `<${next.toString()}>; rel="next"`;
  }
  if (page > 1) {
    const prev = new URL(`${ctx.baseUrl}/api/v3/user/repos`);
    prev.searchParams.set('per_page', String(perPage));
    prev.searchParams.set('page', String(page - 1));
    extra.Link = `${extra.Link !== undefined ? `${extra.Link}, ` : ''}<${prev.toString()}>; rel="prev"`;
  }
  sendJson(res, 200, items, extra);
}

function handleCreateRepo(ctx: RestCtx, res: ServerResponse, body: unknown): void {
  const input = asRecord(body);
  const name = asString(input.name);
  if (name.length === 0 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'missing' }] });
    return;
  }
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'custom', message: 'name already exists on this account' }] });
    return;
  }
  const repo = ctx.store.createRepo(name, input.private === true, asString(input.description));
  seedLabels(repo);
  sendJson(res, 201, repoJson(ctx, repo));
}

function handleGetRepo(ctx: RestCtx, res: ServerResponse, repo: Repo): void {
  sendJson(res, 200, repoJson(ctx, repo));
}

function handlePatchRepo(ctx: RestCtx, res: ServerResponse, repo: Repo, body: unknown): void {
  const input = asRecord(body);
  if (typeof input.description === 'string') repo.description = input.description;
  if (typeof input.default_branch === 'string' && input.default_branch.length > 0) {
    repo.defaultBranch = input.default_branch;
  }
  repo.updatedAt = isoTick();
  sendJson(res, 200, repoJson(ctx, repo));
}

function handleDeleteRepo(ctx: RestCtx, res: ServerResponse, repo: Repo): void {
  ctx.store.deleteRepo(repo);
  requestCounter += 1;
  res.writeHead(204, { 'X-GitHub-Request-Id': `req-${requestCounter}` });
  res.end();
}

function handleListBranches(ctx: RestCtx, res: ServerResponse, repo: Repo): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  sendJson(res, 200, branches);
}

function handleGetBranch(ctx: RestCtx, res: ServerResponse, repo: Repo, branch: string): void {
  const tip = branchTip(repo, branch);
  if (tip === null) {
    notFound(res, 'Branch not found');
    return;
  }
  sendJson(res, 200, { name: branch, commit: { sha: tip } });
}

function handleListCommits(ctx: RestCtx, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const shaParam = query.get('sha');
  let tip: string | null = null;
  if (shaParam !== null) {
    // A branch name or a commit oid.
    tip = branchTip(repo, shaParam) ?? (git.isOid(shaParam) && repo.objects.has(shaParam) ? shaParam : null);
    if (tip === null) {
      notFound(res, 'No commit found for SHA');
      return;
    }
  } else {
    tip = branchTip(repo, repo.defaultBranch);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
  }
  const commits = branchCommits(repo, tip).map((oid) => {
    const obj = repo.objects.get(oid);
    const commit = obj !== undefined && obj.type === 'commit' ? git.parseCommit(obj.data) : null;
    return { sha: oid, commit: { message: commit !== null ? commit.message.replace(/\n$/, '') : '' } };
  });
  sendJson(res, 200, commits);
}

function handleCreateRef(ctx: RestCtx, res: ServerResponse, repo: Repo, body: unknown): void {
  const input = asRecord(body);
  const ref = asString(input.ref);
  const sha = asString(input.sha);
  if (!ref.startsWith('refs/') || !git.isOid(sha) || repo.objects.get(sha)?.type !== 'commit') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'ref', code: 'invalid' }] });
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'ref', code: 'custom', message: 'Reference already exists' }] });
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(res, 201, { ref, object: { sha } });
}

function handleGetRef(ctx: RestCtx, res: ServerResponse, repo: Repo, refParts: string[]): void {
  const ref = `refs/${refParts.join('/')}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) {
    notFound(res, 'Reference does not exist');
    return;
  }
  sendJson(res, 200, { ref, object: { sha: oid } });
}

// -------------------------------------------------------------------------------------------
// Contents
// -------------------------------------------------------------------------------------------

/** The file map at a branch tip. A branch that does not exist yet starts from
 *  the default branch's tip (or from nothing when the repository is unborn). */
function filesAtTip(repo: Repo, branch: string): { files: Map<string, { mode: string; oid: string }>; parents: string[] } {
  let tip = branchTip(repo, branch);
  if (tip === null) tip = branchTip(repo, repo.defaultBranch);
  if (tip === null) return { files: new Map(), parents: [] };
  const obj = repo.objects.get(tip);
  const commit = obj !== undefined && obj.type === 'commit' ? git.parseCommit(obj.data) : null;
  if (commit === null) return { files: new Map(), parents: [] };
  return { files: git.flattenTree(repo, commit.tree), parents: [tip] };
}

function handlePutContents(ctx: RestCtx, res: ServerResponse, repo: Repo, pathParts: string[], query: URLSearchParams, body: unknown): void {
  const input = asRecord(body);
  const filePath = pathParts.join('/');
  const branch = asString(input.branch, repo.defaultBranch);
  const message = asString(input.message, 'Update file');
  const contentB64 = asString(input.content);
  if (contentB64.length === 0) {
    badRequest(res, 'content is required');
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    badRequest(res, 'content is not valid base64');
    return;
  }
  const { files, parents } = filesAtTip(repo, branch);
  const existing = files.get(filePath);
  const givenSha = asString(input.sha);
  if (existing !== undefined && givenSha.length > 0 && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    sendJson(res, 409, { message: 'sha does not match the current file' });
    return;
  }
  if (existing !== undefined && givenSha.length === 0) {
    sendJson(res, 409, { message: 'sha is required to update a file' });
    return;
  }
  const blobOid = git.putObject(repo, 'blob', content);
  files.set(filePath, { mode: '100644', oid: blobOid });
  const treeOid = git.buildTreeFromFiles(repo, files);
  const commitOid = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = isoTick();
  const status = existing === undefined ? 201 : 200;
  sendJson(res, status, {
    content: { sha: blobOid, encoding: 'base64', size: content.length, name: filePath.split('/').pop() ?? '', path: filePath },
    commit: { sha: commitOid, message },
  });
}

function handleGetContents(ctx: RestCtx, res: ServerResponse, repo: Repo, pathParts: string[], query: URLSearchParams): void {
  const branch = asString(query.get('ref'), repo.defaultBranch);
  const tip = branchTip(repo, branch);
  if (tip === null) {
    notFound(res, 'This repository is empty.');
    return;
  }
  const obj = repo.objects.get(tip);
  const commit = obj !== undefined && obj.type === 'commit' ? git.parseCommit(obj.data) : null;
  if (commit === null) {
    notFound(res);
    return;
  }
  const files = git.flattenTree(repo, commit.tree);
  const dirPath = pathParts.join('/');
  if (dirPath === '') {
    // Root listing.
    const entries: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const path of files.keys()) {
      const top = path.split('/')[0];
      if (seen.has(top)) continue;
      seen.add(top);
      const isDir = [...files.keys()].some((p) => p.startsWith(`${top}/`));
      if (isDir) {
        const treeOid = dirTreeOid(repo, commit.tree, top);
        entries.push({ type: 'dir', name: top, path: top, sha: treeOid ?? '' });
      } else {
        const file = files.get(top) as { mode: string; oid: string };
        entries.push({ type: 'file', name: top, path: top, sha: file.oid });
      }
    }
    sendJson(res, 200, entries);
    return;
  }
  const file = files.get(dirPath);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    const data = blob !== undefined ? blob.data : Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: file.oid,
      size: data.length,
      name: dirPath.split('/').pop() ?? '',
      path: dirPath,
    });
    return;
  }
  // Directory listing.
  const prefix = `${dirPath}/`;
  const entries: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const top = rest.split('/')[0];
    if (seen.has(top)) continue;
    seen.add(top);
    const full = `${dirPath}/${top}`;
    if (rest.includes('/')) {
      const treeOid = dirTreeOid(repo, commit.tree, full);
      entries.push({ type: 'dir', name: top, path: full, sha: treeOid ?? '' });
    } else {
      const f = files.get(full) as { mode: string; oid: string };
      entries.push({ type: 'file', name: top, path: full, sha: f.oid });
    }
  }
  if (entries.length === 0) {
    notFound(res);
    return;
  }
  sendJson(res, 200, entries);
}

/** The tree oid of a directory path inside a tree (null when absent). */
function dirTreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter((p) => p.length > 0);
  let cur = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = git.parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    cur = entry.oid;
  }
  return cur;
}

function handleDeleteContents(ctx: RestCtx, res: ServerResponse, repo: Repo, pathParts: string[], body: unknown): void {
  const input = asRecord(body);
  const filePath = pathParts.join('/');
  const branch = asString(input.branch, repo.defaultBranch);
  const message = asString(input.message, 'Delete file');
  const givenSha = asString(input.sha);
  const { files, parents } = filesAtTip(repo, branch);
  const existing = files.get(filePath);
  if (existing === undefined) {
    notFound(res);
    return;
  }
  if (givenSha.length > 0 && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    sendJson(res, 409, { message: 'sha does not match the current file' });
    return;
  }
  files.delete(filePath);
  const treeOid = git.buildTreeFromFiles(repo, files);
  const commitOid = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(res, 200, { commit: { sha: commitOid, message } });
}

// -------------------------------------------------------------------------------------------
// Labels, issues, comments
// -------------------------------------------------------------------------------------------

function handleCreateLabel(ctx: RestCtx, res: ServerResponse, repo: Repo, body: unknown): void {
  const input = asRecord(body);
  const name = asString(input.name);
  const color = asString(input.color, 'ededed').replace(/^#/, '');
  if (name.length === 0) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'missing' }] });
    return;
  }
  const label = { name, color, description: asString(input.description) };
  repo.labels.set(name, label);
  sendJson(res, 201, labelJson(label));
}

function handleListLabels(ctx: RestCtx, res: ServerResponse, repo: Repo): void {
  sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
}

function handleCreateIssue(ctx: RestCtx, res: ServerResponse, repo: Repo, body: unknown): void {
  const input = asRecord(body);
  const title = asString(input.title);
  if (title.length === 0) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing' }] });
    return;
  }
  const labelsInput: string[] = Array.isArray(input.labels)
    ? (input.labels as unknown[]).map((l) => (typeof l === 'string' ? l : asString((l as Record<string, unknown>)?.name)))
    : [];
  for (const name of labelsInput) {
    if (!repo.labels.has(name)) {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'labels', code: 'invalid', message: `label ${name} does not exist` }] });
      return;
    }
  }
  const number = repo.nextNumber++;
  const now = isoTick();
  const issue: Issue = {
    number,
    title,
    body: asString(input.body),
    state: 'open',
    labels: labelsInput,
    createdAt: now,
    updatedAt: now,
    userLogin: VIEWER_LOGIN,
  };
  repo.issues.set(number, issue);
  sendJson(res, 201, issueJson(ctx, repo, issue));
}

function handleListIssues(ctx: RestCtx, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  issues.sort((a, b) => (sort === 'created' ? a.number - b.number : a.number - b.number));
  if (direction === 'desc') issues.reverse();
  sendJson(res, 200, issues.map((issue) => issueJson(ctx, repo, issue)));
}

function handleGetIssue(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Issue not found');
    return;
  }
  sendJson(res, 200, issueJson(ctx, repo, issue));
}

function handlePatchIssue(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number, body: unknown): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Issue not found');
    return;
  }
  const input = asRecord(body);
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
  if (Array.isArray(input.labels)) {
    const names = (input.labels as unknown[]).map((l) => (typeof l === 'string' ? l : asString((l as Record<string, unknown>)?.name)));
    for (const name of names) {
      if (!repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'labels', code: 'invalid' }] });
        return;
      }
    }
    issue.labels = names;
  }
  issue.updatedAt = isoTick();
  sendJson(res, 200, issueJson(ctx, repo, issue));
}

function handleCreateComment(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number, body: unknown): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Issue not found');
    return;
  }
  const input = asRecord(body);
  const text = asString(input.body);
  if (text.length === 0) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'body', code: 'missing' }] });
    return;
  }
  const id = ctx.store.nextCommentIdGlobal();
  const comment = { id, body: text, createdAt: isoTick(), userLogin: VIEWER_LOGIN };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  sendJson(res, 201, {
    id,
    node_id: commentGlobalId(repo, id),
    body: text,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${id}`,
  });
}

function handleListComments(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number): void {
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    notFound(res, 'Issue not found');
    return;
  }
  const list = (repo.comments.get(number) ?? []).map((comment) => ({
    id: comment.id,
    node_id: commentGlobalId(repo, comment.id),
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  }));
  sendJson(res, 200, list);
}

// -------------------------------------------------------------------------------------------
// Pull requests
// -------------------------------------------------------------------------------------------

function handleCreatePull(ctx: RestCtx, res: ServerResponse, repo: Repo, body: unknown): void {
  const input = asRecord(body);
  const head = asString(input.head);
  const base = asString(input.base, repo.defaultBranch);
  const title = asString(input.title);
  if (head.length === 0 || title.length === 0) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'missing' }] });
    return;
  }
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === null || baseSha === null) {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid', message: 'head or base branch does not exist' }] });
    return;
  }
  const number = repo.nextNumber++;
  const now = isoTick();
  const pull: Pull = {
    number,
    title,
    body: asString(input.body),
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
  sendJson(res, 201, pullJson(ctx, repo, pull));
}

function handleListPulls(ctx: RestCtx, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.number - a.number);
  sendJson(res, 200, pulls.map((pull) => pullJson(ctx, repo, pull)));
}

function handleGetPull(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res, 'Pull request not found');
    return;
  }
  sendJson(res, 200, pullJson(ctx, repo, pull));
}

function handleListPullFiles(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res, 'Pull request not found');
    return;
  }
  const baseTip = currentBaseSha(repo, pull);
  const base = mergeBase(repo, pull.headSha, baseTip);
  if (base === null) {
    sendJson(res, 200, []);
    return;
  }
  const diff = diffFiles(repo, base, pull.headSha);
  const files: Array<Record<string, unknown>> = [];
  for (const [path, change] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const additions = change.status === 'added' ? 1 : change.status === 'modified' ? 1 : 0;
    const deletions = change.status === 'removed' ? 1 : change.status === 'modified' ? 1 : 0;
    files.push({
      filename: path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    });
  }
  sendJson(res, 200, files);
}

function handleMergePull(ctx: RestCtx, res: ServerResponse, repo: Repo, number: number, body: unknown): void {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(res, 'Pull request not found');
    return;
  }
  if (pull.state === 'closed') {
    sendJson(res, 405, { message: 'Pull request is already closed' });
    return;
  }
  const input = asRecord(body);
  const method = asString(input.merge_method, 'squash');
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    sendJson(res, 422, { message: 'Validation Failed', errors: [{ field: 'merge_method', code: 'invalid' }] });
    return;
  }
  const message = `Merge pull request #${number} from ${pull.headRef}\n\n${pull.title}`;
  const mergedSha = squashMerge(repo, pull, message);
  if (mergedSha === null) {
    sendJson(res, 405, { message: 'Merge conflict' });
    return;
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergedSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoTick();
  pull.mergeCommitSha = mergedSha;
  pull.updatedAt = pull.mergedAt;
  sendJson(res, 200, { merged: true, sha: mergedSha, message });
}

// -------------------------------------------------------------------------------------------
// Router
// -------------------------------------------------------------------------------------------

/**
 * Handle a REST v3 request. Returns true when handled; the caller 404s when
 * false (unknown route under /api/v3).
 */
export function handleRest(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  body: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const parts = pathname.split('/').filter((p) => p.length > 0);

  // /api/v3/ root and /api/v3/meta and /api/v3/user* — auth required except
  // the root, which the boot probe calls with the token anyway.
  if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'v3') {
    if (parts.length === 2) {
      if (method !== 'GET') return false;
      if (!checkAuth(ctx, req)) {
        unauthorized(res);
        return true;
      }
      handleRoot(ctx, res);
      return true;
    }
    if (parts.length === 3 && parts[2] === 'meta') {
      if (method !== 'GET') return false;
      if (!checkAuth(ctx, req)) {
        unauthorized(res);
        return true;
      }
      handleMeta(res);
      return true;
    }
    if (parts.length === 3 && parts[2] === 'user' && method === 'GET') {
      if (!checkAuth(ctx, req)) {
        unauthorized(res);
        return true;
      }
      handleUser(res);
      return true;
    }
    if (parts.length === 4 && parts[2] === 'user' && parts[3] === 'repos') {
      if (!checkAuth(ctx, req)) {
        unauthorized(res);
        return true;
      }
      if (method === 'GET') {
        handleListUserRepos(ctx, req, res, query);
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (parsed === 'bad') {
          badRequest(res, 'Malformed JSON in request body');
          return true;
        }
        handleCreateRepo(ctx, res, parsed);
        return true;
      }
      return false;
    }
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  const match = matchRepoRoute(pathname);
  if (match === null) return false;
  if (!checkAuth(ctx, req)) {
    unauthorized(res);
    return true;
  }
  const repo = getRepoOr404(ctx, res, match.owner, match.repoName);
  if (repo === null) return true;
  const rest = match.rest;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      handleGetRepo(ctx, res, repo);
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handlePatchRepo(ctx, res, repo, parsed);
      return true;
    }
    if (method === 'DELETE') {
      handleDeleteRepo(ctx, res, repo);
      return true;
    }
    return false;
  }

  // /repos/{o}/{r}/branches[/{branch}]
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      handleListBranches(ctx, res, repo);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      handleGetBranch(ctx, res, repo, decodeURIComponent(rest[1]));
      return true;
    }
    return false;
  }

  // /repos/{o}/{r}/commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    handleListCommits(ctx, res, repo, query);
    return true;
  }

  // /repos/{o}/{r}/git/refs[/...]
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handleCreateRef(ctx, res, repo, parsed);
      return true;
    }
    if (rest.length > 2 && method === 'GET') {
      handleGetRef(ctx, res, repo, rest.slice(2).map((p) => decodeURIComponent(p)));
      return true;
    }
    return false;
  }

  // /repos/{o}/{r}/contents[/{path...}]
  if (rest[0] === 'contents') {
    const pathParts = rest.slice(1).map((p) => decodeURIComponent(p));
    if (method === 'GET') {
      handleGetContents(ctx, res, repo, pathParts, query);
      return true;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handlePutContents(ctx, res, repo, pathParts, query, parsed);
      return true;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handleDeleteContents(ctx, res, repo, pathParts, parsed);
      return true;
    }
    return false;
  }

  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handleCreateLabel(ctx, res, repo, parsed);
      return true;
    }
    if (rest.length === 1 && method === 'GET') {
      handleListLabels(ctx, res, repo);
      return true;
    }
    return false;
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handleCreateIssue(ctx, res, repo, parsed);
      return true;
    }
    if (rest.length === 1 && method === 'GET') {
      handleListIssues(ctx, res, repo, query);
      return true;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(number) || number < 1) return false;
      if (rest.length === 2 && method === 'GET') {
        handleGetIssue(ctx, res, repo, number);
        return true;
      }
      if (rest.length === 2 && method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (parsed === 'bad') {
          badRequest(res, 'Malformed JSON in request body');
          return true;
        }
        handlePatchIssue(ctx, res, repo, number, parsed);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (parsed === 'bad') {
            badRequest(res, 'Malformed JSON in request body');
            return true;
          }
          handleCreateComment(ctx, res, repo, number, parsed);
          return true;
        }
        if (method === 'GET') {
          handleListComments(ctx, res, repo, number);
          return true;
        }
      }
    }
    return false;
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === 'bad') {
        badRequest(res, 'Malformed JSON in request body');
        return true;
      }
      handleCreatePull(ctx, res, repo, parsed);
      return true;
    }
    if (rest.length === 1 && method === 'GET') {
      handleListPulls(ctx, res, repo, query);
      return true;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(number) || number < 1) return false;
      if (rest.length === 2 && method === 'GET') {
        handleGetPull(ctx, res, repo, number);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        handleListPullFiles(ctx, res, repo, number);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (parsed === 'bad') {
          badRequest(res, 'Malformed JSON in request body');
          return true;
        }
        handleMergePull(ctx, res, repo, number, parsed);
        return true;
      }
    }
    return false;
  }

  return false;
}
