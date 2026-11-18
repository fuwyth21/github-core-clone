// graphql.ts — GitHub GraphQL v4, for the documents gh and github-mcp-server send.
//
// A small, targeted executor: a tokenizer + recursive-descent parser for the
// query language subset the suite uses (operations, fields, arguments,
// variables, lists, objects, inline fragments), and a resolver over the same
// store the REST surface uses, so a mutation here reads back over REST.
//
// GraphQL state is UPPERCASE (OPEN/CLOSED, MERGEABLE/CONFLICTING) while the
// REST state is lowercase; the resolver translates. Global ids are the same
// opaque base64 ids the REST surface returns.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import {
  VIEWER_LOGIN,
  commentGlobalId,
  decodeGlobalId,
  isoTick,
  issueGlobalId,
  pullGlobalId,
  repoByGlobalId,
  repoGlobalId,
} from './store.ts';
import { diffFiles, isMergeable, mergeBase, squashMerge } from './rest.ts';
import * as git from './git.ts';
import { sendJson } from './rest.ts';

// -------------------------------------------------------------------------------------------
// Schema (for __type introspection)
// -------------------------------------------------------------------------------------------

const SCHEMA: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Query: { fields: ['viewer', 'repository', 'node', 'search'] },
  Viewer: { fields: ['login', 'id', 'name', 'email'] },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
      'createdAt', 'updatedAt', 'url',
    ],
  },
  User: { fields: ['login', 'id', 'name', 'email'] },
  Ref: { fields: ['name', 'target'] },
  Issue: {
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  },
  PullRequest: {
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
  },
  IssueConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueComment: { fields: ['id', 'body', 'author', 'createdAt'] },
  IssueCommentEdge: { fields: ['node', 'cursor'] },
  IssueEdge: { fields: ['node', 'cursor'] },
  PullRequestEdge: { fields: ['node', 'cursor'] },
  CreateIssuePayload: { fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { fields: ['commentEdge', 'comment', 'clientMutationId'] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

// -------------------------------------------------------------------------------------------
// Parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'var'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'var', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      const raw = input.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: Number.parseFloat(raw) });
      else tokens.push({ kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

export interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: GqlField[];
  fragmentOn: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: GqlField[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok === undefined || tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`expected ${value}`);
    }
  }
  private isPunct(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.kind === 'punct' && tok.value === value;
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') {
        name = maybeName.value;
        this.next();
      }
      // Variable definitions: ($x: Type!, ...). Skip them; values come from the request.
      if (this.isPunct('(')) this.skipBalanced('(', ')');
      // Directives: @foo(...). Skip.
      while (this.isPunct('@')) {
        this.next();
        const d = this.next();
        if (d !== undefined && this.isPunct('(')) this.skipBalanced('(', ')');
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const tok = this.next() as Token;
      if (tok.kind === 'punct' && tok.value === open) depth += 1;
      else if (tok.kind === 'punct' && tok.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.isPunct('}')) {
      const tok = this.peek();
      if (tok === undefined) throw new Error('unterminated selection set');
      if (tok.kind === 'punct' && tok.value === '...') {
        this.next();
        const nextTok = this.peek();
        if (nextTok !== undefined && nextTok.kind === 'name' && nextTok.value === 'on') {
          this.next();
          const typeTok = this.next();
          const typeName = typeTok !== undefined && typeTok.kind === 'name' ? typeTok.value : '';
          const children = this.parseSelectionSet();
          for (const child of children) fields.push({ ...child, fragmentOn: typeName });
        } else {
          // Named fragment spread: skip (the suite sends none).
          this.next();
          if (this.isPunct('{')) this.skipBalanced('{', '}');
        }
        continue;
      }
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): GqlField {
    const first = this.next();
    if (first === undefined || first.kind !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      const real = this.next();
      if (real === undefined || real.kind !== 'name') throw new Error('expected a field name after alias');
      alias = name;
      name = real.value;
    }
    let args: Record<string, unknown> = {};
    if (this.isPunct('(')) args = this.parseArguments();
    // Directives on the field: skip.
    while (this.isPunct('@')) {
      this.next();
      this.next();
      if (this.isPunct('(')) this.skipBalanced('(', ')');
    }
    let children: GqlField[] = [];
    if (this.isPunct('{')) children = this.parseSelectionSet();
    return { name, alias, args, children, fragmentOn: null };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!this.isPunct(')')) {
      const nameTok = this.next();
      if (nameTok === undefined || nameTok.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[nameTok.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const tok = this.next();
    if (tok === undefined) throw new Error('expected a value');
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'int' || tok.kind === 'float') return tok.value;
    if (tok.kind === 'var') {
      const value = this.variables[tok.value];
      return value === undefined ? null : value;
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return tok.value; // enum value
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const list: unknown[] = [];
      while (!this.isPunct(']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const keyTok = this.next();
        if (keyTok === undefined || keyTok.kind !== 'name') throw new Error('expected an object key');
        this.expectPunct(':');
        obj[keyTok.value] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error(`unexpected token ${JSON.stringify(tok)}`);
  }
}

export function parseDocument(query: string, variables: Record<string, unknown>): GqlOperation {
  const tokens = tokenize(query);
  const parser = new Parser(tokens, variables);
  return parser.parseOperation();
}

// -------------------------------------------------------------------------------------------
// Resolver
// -------------------------------------------------------------------------------------------

type Node =
  | { __type: 'Query' }
  | { __type: 'Viewer' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'User'; login: string }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; repo: Repo; items: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; repo: Repo; items: Pull[] }
  | { __type: 'PullRequestFileConnection'; files: Array<{ path: string; status: string }> }
  | { __type: 'PullRequestFile'; path: string; status: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'IssueComment'; repo: Repo; comment: { id: number; body: string } }
  | { __type: 'IssueCommentEdge'; node: Node }
  | { __type: 'IssueEdge'; node: Node; cursor: string }
  | { __type: 'PullRequestEdge'; node: Node; cursor: string }
  | { __type: 'CreateIssuePayload'; issue: Node }
  | { __type: 'CloseIssuePayload'; issue: Node }
  | { __type: 'CreatePullRequestPayload'; pullRequest: Node }
  | { __type: 'MergePullRequestPayload'; pullRequest: Node }
  | { __type: 'AddCommentPayload'; commentEdge: Node }
  | { __type: '__Type'; name: string };

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? null : Number.parseInt(m[1], 10);
  } catch {
    return null;
  }
}

interface Ctx {
  store: Store;
}

function resolveIssues(repo: Repo, args: Record<string, unknown>): Node {
  let items = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    items = items.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  items.sort((a, b) => a.number - b.number);
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') items.reverse();
  let startIdx = 0;
  if (typeof args.after === 'string' && args.after.length > 0) {
    const n = decodeCursor(args.after);
    if (n !== null) {
      const idx = items.findIndex((i) => i.number === n);
      if (idx >= 0) startIdx = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(startIdx, startIdx + first);
  const hasNextPage = startIdx + page.length < items.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return { __type: 'IssueConnection', repo, items: page, hasNextPage, endCursor };
}

function resolvePullRequests(repo: Repo, args: Record<string, unknown>): Node {
  let items = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    items = items.filter((p) => wanted.has(p.state.toUpperCase()));
  }
  items.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : items.length;
  return { __type: 'PullRequestConnection', repo, items: items.slice(0, first) };
}

function resolvePullFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): Node {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, pull.headSha, baseTip);
  const files: Array<{ path: string; status: string }> = [];
  if (base !== null) {
    const diff = diffFiles(repo, base, pull.headSha);
    for (const [path, change] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      files.push({ path, status: change.status });
    }
  }
  const first = typeof args.first === 'number' ? args.first : files.length;
  return { __type: 'PullRequestFileConnection', files: files.slice(0, first) };
}

function findIssueByGlobalId(ctx: Ctx, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const dbId = Number(decoded.parts[1]);
  const number = Number(decoded.parts[2]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== dbId) continue;
    const issue = repo.issues.get(number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(ctx: Ctx, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const dbId = Number(decoded.parts[1]);
  const number = Number(decoded.parts[2]);
  if (!Number.isInteger(dbId) || !Number.isInteger(number)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.databaseId !== dbId) continue;
    const pull = repo.pulls.get(number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function createIssueNode(ctx: Ctx, input: Record<string, unknown>): Node | null {
  const repo = repoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
  if (repo === undefined) return null;
  const title = typeof input.title === 'string' ? input.title : '';
  if (title.length === 0) return null;
  const number = repo.nextNumber++;
  const now = isoTick();
  const issue: Issue = {
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    createdAt: now,
    updatedAt: now,
    userLogin: VIEWER_LOGIN,
  };
  repo.issues.set(number, issue);
  return { __type: 'Issue', repo, issue };
}

function createPullNode(ctx: Ctx, input: Record<string, unknown>): Node | null {
  const repo = repoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
  if (repo === undefined) return null;
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? repo.defaultBranch);
  const title = typeof input.title === 'string' ? input.title : '';
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined || title.length === 0) return null;
  const number = repo.nextNumber++;
  const now = isoTick();
  const pull: Pull = {
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    headSha,
    baseRef,
    baseSha,
    createdAt: now,
    updatedAt: now,
    userLogin: VIEWER_LOGIN,
  };
  repo.pulls.set(number, pull);
  return { __type: 'PullRequest', repo, pull };
}

/** Resolve one field on a node. Returns a scalar, a Node, an array, or null. */
function resolveField(ctx: Ctx, node: Node, field: GqlField): unknown {
  const args = field.args;
  switch (node.__type) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'Viewer' } as Node;
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? null : ({ __type: 'Repository', repo } as Node);
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(ctx.store, id);
          return repo === undefined ? null : ({ __type: 'Repository', repo } as Node);
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(ctx, id);
          return found === null ? null : ({ __type: 'Issue', repo: found.repo, issue: found.issue } as Node);
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(ctx, id);
          return found === null ? null : ({ __type: 'PullRequest', repo: found.repo, pull: found.pull } as Node);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        return { __type: '__Type', name } as Node;
      }
      return undefined;
    }
    case 'Viewer': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return Buffer.from(`User:1000`, 'utf8').toString('base64');
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      return undefined;
    }
    case 'Repository': {
      const repo = node.repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.databaseId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'owner': return { __type: 'User', login: repo.owner } as Node;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : ({ __type: 'Ref', name: repo.defaultBranch } as Node);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'issue': {
          const number = Number(args.number);
          const issue = repo.issues.get(number);
          return issue === undefined ? null : ({ __type: 'Issue', repo, issue } as Node);
        }
        case 'issues': return resolveIssues(repo, args);
        case 'pullRequests': return resolvePullRequests(repo, args);
        case 'pullRequest': {
          const number = Number(args.number);
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } as Node);
        }
        default: return undefined;
      }
    }
    case 'User': {
      if (field.name === 'login') return node.login;
      if (field.name === 'id') return Buffer.from(`User:1000`, 'utf8').toString('base64');
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      return undefined;
    }
    case 'Ref': {
      if (field.name === 'name') return node.name;
      return undefined;
    }
    case 'Issue': {
      const { repo, issue } = node;
      switch (field.name) {
        case 'id': return issueGlobalId(repo, issue.number);
        case 'databaseId': return repo.databaseId * 100000 + issue.number;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return { __type: 'User', login: issue.userLogin } as Node;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default: return undefined;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = node;
      switch (field.name) {
        case 'id': return pullGlobalId(repo, pull.number);
        case 'databaseId': return repo.databaseId * 100000 + pull.number;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return isMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __type: 'Ref', name: pull.headRef } as Node;
        case 'baseRef': return { __type: 'Ref', name: pull.baseRef } as Node;
        case 'files': return resolvePullFiles(repo, pull, args);
        case 'author': return { __type: 'User', login: pull.userLogin } as Node;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        default: return undefined;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return node.items.map((issue) => ({ __type: 'Issue', repo: node.repo, issue } as Node));
      if (field.name === 'edges') return node.items.map((issue) => ({ __type: 'IssueEdge', node: { __type: 'Issue', repo: node.repo, issue } as Node, cursor: encodeCursor(issue.number) } as Node));
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor } as Node;
      if (field.name === 'totalCount') return node.items.length;
      return undefined;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return node.items.map((pull) => ({ __type: 'PullRequest', repo: node.repo, pull } as Node));
      if (field.name === 'edges') return node.items.map((pull) => ({ __type: 'PullRequestEdge', node: { __type: 'PullRequest', repo: node.repo, pull } as Node, cursor: encodeCursor(pull.number) } as Node));
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as Node;
      if (field.name === 'totalCount') return node.items.length;
      return undefined;
    }
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return node.files.map((f) => ({ __type: 'PullRequestFile', path: f.path, status: f.status } as Node));
      if (field.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as Node;
      if (field.name === 'totalCount') return node.files.length;
      return undefined;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return node.path;
      if (field.name === 'changeType') return node.status.toUpperCase();
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      if (field.name === 'endCursor') return node.endCursor;
      return undefined;
    }
    case 'IssueComment': {
      if (field.name === 'id') return commentGlobalId(node.repo, node.comment.id);
      if (field.name === 'body') return node.comment.body;
      if (field.name === 'author') return { __type: 'User', login: VIEWER_LOGIN } as Node;
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return node.node;
      if (field.name === 'cursor') return '';
      return undefined;
    }
    case 'IssueEdge':
    case 'PullRequestEdge': {
      if (field.name === 'node') return node.node;
      if (field.name === 'cursor') return node.cursor;
      return undefined;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return node.issue;
      return undefined;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return node.issue;
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return node.pullRequest;
      return undefined;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return node.pullRequest;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return node.commentEdge;
      return undefined;
    }
    case '__Type': {
      const schema = SCHEMA[node.name];
      if (field.name === 'name') return node.name;
      if (field.name === 'kind') return schema !== undefined && schema.enumValues !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        if (schema === undefined) return null;
        return schema.fields.map((name) => ({ __type: '__FieldName', name } as unknown as Node));
      }
      if (field.name === 'enumValues') {
        if (schema === undefined || schema.enumValues === undefined) return null;
        return schema.enumValues.map((name) => ({ __type: '__EnumName', name } as unknown as Node));
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Is this value a node (has a __type tag)? */
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

/** Execute a selection set against a node, collecting field errors. */
function executeSelection(
  ctx: Ctx,
  node: Node,
  fields: GqlField[],
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentOn !== null && field.fragmentOn !== node.__type) continue;
    const key = field.alias ?? field.name;
    // __Field and __EnumValue pseudo-nodes resolve their name directly.
    if ((node as unknown as Record<string, unknown>).__type === '__FieldName' || (node as unknown as Record<string, unknown>).__type === '__EnumName') {
      if (field.name === 'name') out[key] = (node as unknown as { name: string }).name;
      else if (field.name === 'description') out[key] = null;
      else errors.push({ message: `Cannot query field "${field.name}" on type "${(node as unknown as { __type: string }).__type}".` });
      continue;
    }
    const value = resolveField(ctx, node, field);
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${node.__type}".` });
      continue;
    }
    out[key] = executeValue(ctx, value, field.children, errors);
  }
  return out;
}

function executeValue(ctx: Ctx, value: unknown, children: GqlField[], errors: Array<{ message: string }>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => executeValue(ctx, item, children, errors));
  if (isNode(value)) {
    if (children.length === 0) return null;
    return executeSelection(ctx, value, children, errors);
  }
  return value;
}

/** Execute one operation (query or mutation) against the store. */
function executeOperation(
  ctx: Ctx,
  operation: GqlOperation,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  if (operation.kind === 'mutation') {
    const data: Record<string, unknown> = {};
    for (const field of operation.fields) {
      const key = field.alias ?? field.name;
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const issue = createIssueNode(ctx, input);
        data[key] = issue === null ? null : executeSelection(ctx, { __type: 'CreateIssuePayload', issue } as Node, field.children, errors);
      } else if (field.name === 'closeIssue') {
        const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
        if (found === null) {
          data[key] = null;
        } else {
          found.issue.state = 'closed';
          found.issue.updatedAt = isoTick();
          data[key] = executeSelection(ctx, { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo: found.repo, issue: found.issue } as Node } as Node, field.children, errors);
        }
      } else if (field.name === 'createPullRequest') {
        const pull = createPullNode(ctx, input);
        data[key] = pull === null ? null : executeSelection(ctx, { __type: 'CreatePullRequestPayload', pullRequest: pull } as Node, field.children, errors);
      } else if (field.name === 'mergePullRequest') {
        const found = findPullByGlobalId(ctx, String(input.pullRequestId ?? ''));
        if (found === null) {
          data[key] = null;
        } else {
          const message = `Merge pull request #${found.pull.number} from ${found.pull.headRef}\n\n${found.pull.title}`;
          const mergedSha = squashMerge(found.repo, found.pull, message);
          if (mergedSha !== null) {
            found.repo.refs.set(`refs/heads/${found.pull.baseRef}`, mergedSha);
            found.pull.state = 'closed';
            found.pull.merged = true;
            found.pull.mergedAt = isoTick();
            found.pull.mergeCommitSha = mergedSha;
            found.pull.updatedAt = found.pull.mergedAt;
          }
          data[key] = executeSelection(ctx, { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo: found.repo, pull: found.pull } as Node } as Node, field.children, errors);
        }
      } else if (field.name === 'addComment') {
        const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
        const body = typeof input.body === 'string' ? input.body : '';
        if (found === null || body.length === 0) {
          data[key] = null;
        } else {
          const id = ctx.store.nextCommentIdGlobal();
          const comment = { id, body, createdAt: isoTick(), userLogin: VIEWER_LOGIN };
          const list = found.repo.comments.get(found.issue.number) ?? [];
          list.push(comment);
          found.repo.comments.set(found.issue.number, list);
          const edge: Node = { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', repo: found.repo, comment } as Node };
          data[key] = executeSelection(ctx, { __type: 'AddCommentPayload', commentEdge: edge } as Node, field.children, errors);
        }
      } else {
        errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
        data[key] = null;
      }
    }
    return { data, errors };
  }
  const data = executeSelection(ctx, { __type: 'Query' } as Node, operation.fields, errors);
  return { data, errors };
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

export interface GraphqlCtx {
  store: Store;
  token: string;
}

function checkAuth(ctx: GraphqlCtx, req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented.length === 0) return false;
  if (ctx.token.length > 0) return presented === ctx.token;
  return true;
}

/** Handle POST /api/graphql (single operation or a batch array). */
export function handleGraphql(
  ctx: GraphqlCtx,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): boolean {
  if (!checkAuth(ctx, req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON in request body' });
    return true;
  }
  const operations: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<Record<string, unknown>> = [];
  for (const op of operations) {
    const record = (typeof op === 'object' && op !== null ? op : {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    if (query.length === 0) {
      results.push({ errors: [{ message: 'Must provide a query.' }] });
      continue;
    }
    let operation: GqlOperation;
    try {
      operation = parseDocument(query, variables);
    } catch (err) {
      results.push({ errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] });
      continue;
    }
    const { data, errors } = executeOperation(ctx, operation);
    const result: Record<string, unknown> = { data };
    if (errors.length > 0) result.errors = errors;
    results.push(result);
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}
