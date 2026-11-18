// githttp.ts — git smart HTTP: upload-pack v2/v0 and receive-pack v0.
//
// The suite speaks the protocol in-process with its own client (no git
// binary), so this implements the wire format exactly as that client reads
// it: pkt-lines, sideband, capability advertisement, ls-refs, fetch with
// depth/shallow, and fast-forward-only receive-pack.
//
// Auth: git requests are served regardless of the Authorization header (the
// suite drives git without an auth check; the token is for the REST/GraphQL/
// MCP surfaces).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { VIEWER_LOGIN, ZERO_OID } from './store.ts';
import * as git from './git.ts';
import type { GitObject, ObjType } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Sorted ref names, for stable advertisements. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** Is this ref an annotated tag (its object is a tag whose target is a commit)? */
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  if (m === null) return null;
  const target = repo.objects.get(m[1]);
  if (target === undefined || target.type !== 'commit') return null;
  return m[1];
}

// -------------------------------------------------------------------------------------------
// Advertisements
// -------------------------------------------------------------------------------------------

function advertiseV2Upload(): Buffer {
  return git.encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'fetch=shallow wait-for-done filter\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    `agent=${git.AGENT}\n`,
    'flush',
  ]);
}

function advertiseV0Upload(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${git.AGENT}`;
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = headOid(repo);
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  return git.encodePktLines(lines);
}

function advertiseV0Receive(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${git.AGENT}`;
  const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = headOid(repo);
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  return git.encodePktLines(lines);
}

// -------------------------------------------------------------------------------------------
// ls-refs (v2)
// -------------------------------------------------------------------------------------------

interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(packets: git.Pkt[]): LsRefsRequest {
  const req: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=ls-refs') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (!seenDelim) continue;
    if (line === 'peel') req.peel = true;
    else if (line === 'symrefs') req.symrefs = true;
    else if (line === 'unborn') req.unborn = true;
    else if (line.startsWith('ref-prefix ')) req.prefixes.push(line.slice('ref-prefix '.length));
  }
  return req;
}

function handleLsRefs(repo: Repo, req: LsRefsRequest): Buffer {
  const out: Buffer[] = [];
  const head = headOid(repo);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const keep = (name: string): boolean =>
    req.prefixes.length === 0 || req.prefixes.some((p) => name.startsWith(p));
  // HEAD first. An empty repo reports only HEAD (unborn).
  if (keep('HEAD')) {
    if (head === ZERO_OID) {
      out.push(git.pktLine(req.unborn ? `unborn HEAD symref-target:${defaultRef}\n` : `${ZERO_OID} HEAD symref-target:${defaultRef}\n`));
    } else if (req.symrefs) {
      out.push(git.pktLine(`${head} HEAD symref-target:${defaultRef}\n`));
    } else {
      out.push(git.pktLine(`${head} HEAD\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (req.peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(git.pktLine(`${line}\n`));
  }
  out.push(git.pktFlush());
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------------------
// Fetch
// -------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function parseFetchV2(packets: git.Pkt[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (!seenDelim) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'wait-for-done') continue;
    if (line.startsWith('filter ')) req.filter = line.slice(7);
    else if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) req.depth = n;
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // Not supported by the suite's requests; ignore.
    } else if (line === 'done') {
      // end of arguments
    }
  }
  return req;
}

function parseFetchV0(packets: git.Pkt[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  let section = 0; // 0 = wants, 1 = haves
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        // First want line carries capabilities after the oid.
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        req.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) req.depth = n;
      }
    } else {
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
      else if (line === 'done') {
        // end
      }
    }
  }
  return req;
}

interface FetchPlan {
  /** Objects to send, as oids. */
  send: Set<string>;
  newShallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const wants = [...new Set(req.wants)];
  const haves = [...new Set(req.haves)];
  const shallowList = [...new Set(req.shallow)];
  const shallowSet = new Set(shallowList);

  // Held: what the client already has — the full closure of its haves (minus
  // its shallow boundaries) plus each shallow boundary and its tree closure.
  const held = new Set<string>();
  const havesFull = haves.filter((h) => !shallowSet.has(h));
  const haveDepths = git.walkCommits(repo, havesFull, null);
  for (const oid of haveDepths.keys()) {
    held.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      const commit = git.parseCommit(obj.data);
      if (commit !== null) git.treeClosure(repo, commit.tree, held);
    }
  }
  for (const boundary of shallowList) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    held.add(boundary);
    const commit = git.parseCommit(obj.data);
    if (commit !== null) git.treeClosure(repo, commit.tree, held);
  }

  // Included: commits reachable from the wants, within the depth limit.
  const commitWants: string[] = [];
  const directObjects = new Set<string>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') commitWants.push(want);
    else if (obj.type === 'tag') {
      // The tag object itself is sent, and the walk continues at its target.
      directObjects.add(want);
      const peeled = peeledOid(repo, want);
      if (peeled !== null) commitWants.push(peeled);
    } else {
      directObjects.add(want);
    }
  }
  const included = git.walkCommits(repo, commitWants, req.depth);

  // Send: included commits and their tree closures, minus held.
  const send = new Set<string>(directObjects);
  for (const oid of included.keys()) {
    if (held.has(oid)) continue;
    send.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      const commit = git.parseCommit(obj.data);
      if (commit !== null) {
        const closure = new Set<string>();
        git.treeClosure(repo, commit.tree, closure);
        for (const o of closure) if (!held.has(o)) send.add(o);
      }
    }
  }

  // New shallow boundaries: included commits at exactly the depth limit.
  const newShallow: string[] = [];
  if (req.depth !== null) {
    for (const [oid, d] of included) if (d === req.depth) newShallow.push(oid);
  }

  // Unshallow: old boundaries whose parents are all held or included.
  const known = new Set<string>([...held, ...included.keys()]);
  const unshallow: string[] = [];
  for (const boundary of shallowList) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = git.parseCommit(obj.data);
    if (commit === null) continue;
    if (commit.parents.every((p) => known.has(p))) unshallow.push(boundary);
  }

  // Acknowledgments: ACK every recognized have, then ready; NAK when none.
  const acks: string[] = [];
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (obj !== undefined && obj.type === 'commit') acks.push(have);
  }
  return { send, newShallow, unshallow, acks, nak: acks.length === 0 };
}

/** Build the pack for a fetch plan (plain objects, deterministic order). */
function buildFetchPack(repo: Repo, send: Set<string>): Buffer | null {
  if (send.size === 0) return null;
  const oids = [...send].sort();
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of oids) {
    const obj: GitObject | undefined = repo.objects.get(oid);
    if (obj === undefined) continue;
    objects.push({ type: obj.type, data: obj.data });
  }
  if (objects.length === 0) return null;
  return git.writePack(objects);
}

function respondFetchV2(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  parts.push(git.pktLine('acknowledgments\n'));
  if (plan.nak) {
    parts.push(git.pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(git.pktLine(`ACK ${ack}\n`));
    parts.push(git.pktLine('ready\n'));
  }
  parts.push(git.pktDelim());
  parts.push(git.pktLine('shallow-info\n'));
  for (const oid of plan.newShallow) parts.push(git.pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(git.pktLine(`unshallow ${oid}\n`));
  parts.push(git.pktDelim());
  const pack = buildFetchPack(repo, plan.send);
  if (pack !== null) {
    parts.push(git.pktLine('packfile\n'));
    for (const packet of git.sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(git.pktFlush());
  return Buffer.concat(parts);
}

function respondFetchV0(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  if (plan.nak) {
    parts.push(git.pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(git.pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.newShallow) parts.push(git.pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(git.pktLine(`unshallow ${oid}\n`));
  const pack = buildFetchPack(repo, plan.send);
  if (pack !== null) {
    for (const packet of git.sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(git.pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// Receive-pack (push)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const packets = git.decodePktLines(body);
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let offset = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      // The pack follows the flush packet (4 bytes) in the raw body.
      packStart = offset + 4;
      break;
    }
    if (packet.kind !== 'data') {
      offset += 4;
      continue;
    }
    // Recompute this packet's length to advance the offset.
    const len = packet.payload.length + 4;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length >= 3 && git.isOid(parts[0]) && git.isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    offset += len;
  }
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack };
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parsePushBody(body);
  let unpackOk = true;
  if (pack !== null && pack.length > 0) {
    try {
      const read = git.readPack(pack);
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  const report: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack error';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'non-fast-forward';
      else if (command.oldOid !== current) reason = 'non-fast-forward';
      else {
        repo.refs.delete(command.ref);
        ok = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) reason = 'non-fast-forward';
      else if (!repo.objects.has(command.newOid)) reason = 'non-fast-forward';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else {
      // Update: old must be the current tip, new must descend from it.
      if (current === undefined) reason = 'non-fast-forward';
      else if (command.oldOid !== current) reason = 'non-fast-forward';
      else if (command.newOid === current) ok = true; // no-op update
      else if (!repo.objects.has(command.newOid)) reason = 'non-fast-forward';
      else if (!git.isAncestor(repo, current, command.newOid)) reason = 'non-fast-forward';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    }
    report.push(ok ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }
  const parts: Buffer[] = [];
  for (const line of report) {
    parts.push(git.sidebandPacket(1, Buffer.from(`${line}\n`, 'utf8')));
  }
  parts.push(git.pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// Routing
// -------------------------------------------------------------------------------------------

export interface GitRoute {
  owner: string;
  repoName: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  path: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

/** Match /{owner}/{repo}.git/info/refs or /{owner}/{repo}.git/git-{upload,receive}-pack. */
export function matchGitRoute(pathname: string): GitRoute | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (m === null) return null;
  const service =
    m[3] === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
  const path =
    m[3] === 'info/refs' ? 'info/refs' : m[3] === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  return { owner: m[1], repoName: m[2], service, path };
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
}

/**
 * Handle a git smart-HTTP request. Returns true when handled (including the
 * 404 for a missing repository, which must not take the server down).
 */
export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  route: GitRoute,
  query: URLSearchParams,
  body: Buffer,
): boolean {
  // The token's repositories live under the viewer; any other owner is 404.
  if (route.owner !== VIEWER_LOGIN) {
    if (route.path === 'info/refs') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = store.getRepo(route.owner, route.repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (route.path === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (v2) sendBuffer(res, 200, UPLOAD_AD, advertiseV2Upload());
      else sendBuffer(res, 200, UPLOAD_AD, advertiseV0Upload(repo));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, RECEIVE_AD, advertiseV0Receive(repo));
      return true;
    }
    sendJson(res, 400, { message: 'Missing service parameter' });
    return true;
  }

  if (route.path === 'git-upload-pack') {
    const packets = git.decodePktLines(body);
    const first = packets.find((p) => p.kind === 'data');
    const firstLine = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8') : '';
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2') || firstLine.startsWith('command=');
    if (v2 && firstLine.startsWith('command=ls-refs')) {
      sendBuffer(res, 200, UPLOAD_RESULT, handleLsRefs(repo, parseLsRefs(packets)));
      return true;
    }
    if (v2) {
      sendBuffer(res, 200, UPLOAD_RESULT, respondFetchV2(repo, parseFetchV2(packets)));
      return true;
    }
    sendBuffer(res, 200, UPLOAD_RESULT, respondFetchV0(repo, parseFetchV0(packets)));
    return true;
  }

  // git-receive-pack
  sendBuffer(res, 200, RECEIVE_RESULT, handleReceivePack(repo, body));
  return true;
}
