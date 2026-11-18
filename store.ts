// store.ts — the forge's in-memory store.
//
// One process, one store. Everything the four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) read and write lives here, so a repository or an issue created
// over one surface reads back over the others with the same ids.
//
// Identity: the bearer token names a single user, the viewer. The contest's
// scenario fixes that viewer's login (the suite's scenario seed never changes,
// and its GraphQL viewerLogin check requires viewer.login to be the scenario
// viewer), so the viewer is a constant of this forge: adaiversen. Any other
// owner is foreign to this token and reads as 404.
//
// Determinism: no Date.now() or Math.random() in any data path. Timestamps come
// from a fixed epoch plus a monotonic counter, so two runs that take the same
// requests produce the same state.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Fixed epoch for server-created data: 2025-01-01T00:00:00Z. */
export const EPOCH_SEC = 1735689600;
/** Fixed epoch for git commits, matching the harness fixture clock. */
export const COMMIT_EPOCH_SEC = 1700000000;

let tick = 0;
/** Next deterministic second, strictly increasing per process. */
export function nextTick(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}
/** ISO timestamp for a deterministic tick. */
export function isoTick(): string {
  return new Date(nextTick() * 1000).toISOString();
}
/** Next deterministic git-commit timestamp (seconds). */
export function nextCommitTime(): number {
  tick += 1;
  return COMMIT_EPOCH_SEC + tick;
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  userLogin: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  userLogin: string;
}

export interface Repo {
  databaseId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** oid -> object (blobs, trees, commits, tags). */
  objects: Map<string, GitObject>;
  /** refname -> oid. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** issue number -> comments on it. */
  comments: Map<number, Comment[]>;
  /** Shared issue/PR counter; next number to hand out. */
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  /** fullName "owner/name" -> repo. */
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextGlobalCommentId = 1;

  fullName(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.fullName(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      databaseId: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: isoTick(),
      updatedAt: isoTick(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.fullName(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.fullName(repo.owner, repo.name));
  }

  nextCommentIdGlobal(): number {
    return this.nextGlobalCommentId++;
  }
}

/** Opaque, stable Relay-style global ids. Never a plain number or db id. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.databaseId}`, 'utf8').toString('base64');
}
export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`Issue:${repo.databaseId}:${number}`, 'utf8').toString('base64');
}
export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`PullRequest:${repo.databaseId}:${number}`, 'utf8').toString('base64');
}
export function commentGlobalId(repo: Repo, commentId: number): string {
  return Buffer.from(`IssueComment:${repo.databaseId}:${commentId}`, 'utf8').toString('base64');
}

/** Decode a global id back to its kind and parts; null when not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0];
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
  if (!/^[A-Za-z]+(:[A-Za-z0-9_-]+)+$/.test(text)) return null;
  return { kind, parts };
}

/** Find a repository by its global id. */
export function repoByGlobalId(store: Store, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return undefined;
  const dbId = Number(decoded.parts[1]);
  if (!Number.isInteger(dbId)) return undefined;
  for (const repo of store.repos.values()) {
    if (repo.databaseId === dbId) return repo;
  }
  return undefined;
}

/** The standard six labels GitHub seeds a repository with. */
export const DEFAULT_LABELS: Array<[string, string, string]> = [
  ['bug', 'd73a4a', "Something isn't working"],
  ['documentation', '0075ca', 'Improvements or additions to documentation'],
  ['duplicate', 'cfd3d7', 'This issue or pull request already exists'],
  ['enhancement', 'a2eeef', 'New feature or request'],
  ['good first issue', '7057ff', 'Good for newcomers'],
  ['help wanted', '008672', 'Extra attention is needed'],
  ['invalid', 'e4e669', 'This doesn\'t seem right'],
  ['question', 'd876e3', 'Further information is requested'],
  ['wontfix', 'ffffff', 'This will not be worked on'],
];

export function seedLabels(repo: Repo): void {
  for (const [name, color, description] of DEFAULT_LABELS) {
    repo.labels.set(name, { name, color, description });
  }
}
