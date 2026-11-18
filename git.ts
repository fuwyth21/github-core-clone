// git.ts — the git object model, packfiles and reachability.
//
// Pure git, no git binary: SHA-1 object ids, zlib-deflated pack v2 files
// (plain objects, no deltas on write; OFS_DELTA and REF_DELTA resolved on
// read), and the walk the fetch algorithm needs.
//
// Node 22 compatible: node:crypto, node:zlib only.

import { createHash, timingSafeEqual } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { GitObject, ObjType, Repo } from './store.ts';
import { ZERO_OID } from './store.ts';

export const AGENT = 'makefun-git-forge/1.0';

/** Is this a 40-hex object id? */
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** The git object id for a type + payload. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in a repo (idempotent) and return its oid. */
export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// -------------------------------------------------------------------------------------------
// Commits and trees
// -------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's payload. Returns null when malformed. */
export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!isOid(tree)) return null;
  for (const p of parents) if (!isOid(p)) return null;
  return { tree, parents, author, committer, message };
}

export function serializeCommit(c: CommitInfo): Buffer {
  let out = `tree ${c.tree}\n`;
  for (const p of c.parents) out += `parent ${p}\n`;
  out += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's payload into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build a tree (and its subtrees) from a flat file map, storing every object.
 * paths are slash-separated; mode is '100644' for files, '40000' for dirs.
 */
export function buildTreeFromFiles(
  repo: Repo,
  files: Map<string, { mode: string; oid: string }>,
): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, dir] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(dir) });
    }
    for (const [name, file] of node.files) {
      entries.push({ mode: file.mode, name, oid: file.oid });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return putObject(repo, 'tree', serializeTree(entries));
  };
  return build(root);
}

/** Flatten a tree (recursively) into a path -> {mode, oid} map. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Collect a tree's closure (the tree, its subtrees and its blobs) into a set. */
export function treeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    into.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
}

/** Walk commits from tips; returns a map oid -> depth (1 = a tip). depthLimit caps the walk. */
export function walkCommits(
  repo: Repo,
  tips: string[],
  depthLimit: number | null,
): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (!isOid(tip) || depth.has(tip)) continue;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') continue;
    depth.set(tip, 1);
    queue.push(tip);
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    const d = depth.get(oid) as number;
    if (depthLimit !== null && d >= depthLimit) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (depth.has(parent)) continue;
      if (!repo.objects.has(parent)) continue;
      depth.set(parent, d + 1);
      queue.push(parent);
    }
  }
  return depth;
}

/** Is `ancestor` an ancestor of (or equal to) `oid`? */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>([oid]);
  const stack = [oid];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of lines / flush / delim markers into pkt-lines. */
export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into packets. Stops at the first malformed line. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(i + 4, i + len)) });
    i += len;
  }
  return out;
}

/** A sideband packet: band byte + data, framed as one pkt-line. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a payload into sideband packets of at most 65515 data bytes each. */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let i = 0; i < data.length; i += MAX) {
    out.push(sidebandPacket(band, data.subarray(i, Math.min(data.length, i + MAX))));
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Packfiles
// -------------------------------------------------------------------------------------------

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack v2 of plain (undeltified) objects, with a SHA-1 trailer. */
export function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const deflated = deflateSync(obj.data);
    const typeCode = TYPE_CODES[obj.type];
    // varint header: low 4 bits of size in the first byte, then 7 bits per byte.
    let size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's SHA-1 trailer. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex')), expected, actual };
}

interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a pack v2, resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Buffer, opts?: { resolveBase?: (oid: string) => GitObject | undefined }): ReadPackResult {
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    return { objects, deltaCount };
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { objects, deltaCount };
  const count = pack.readUInt32BE(8);
  let pos = 12;
  // First pass: read every entry's raw data; deltas are resolved after, since a
  // delta's base may appear later in the pack.
  interface Entry {
    type: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const entries: Entry[] = [];
  const offsetToOid = new Map<number, string>();
  for (let n = 0; n < count && pos < pack.length - 20; n++) {
    const entryOffset = pos;
    let byte = pack[pos++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: offset encoding — value = ((value + 1) << 7) | (byte & 0x7f).
      byte = pack[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - offset;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateAt(pack, pos);
    const data = inflated.data;
    if (data.length !== size) {
      // Size mismatch: trust the inflated data anyway (defensive).
    }
    pos = inflated.next;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      entries.push({ type: typeCode === 6 ? 'ofs-delta' : 'ref-delta', data, baseOffset, baseOid, offset: entryOffset });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) continue;
      const oid = objectId(type, data);
      objects.set(oid, { type, data });
      offsetToOid.set(entryOffset, oid);
      entries.push({ type, data, offset: entryOffset });
    }
  }
  // Second pass: resolve deltas (a delta's base may itself be a delta).
  // An offset -> entry index keeps base lookups O(1) instead of a linear scan.
  const offsetToEntry = new Map<number, Entry>();
  for (const entry of entries) offsetToEntry.set(entry.offset, entry);
  const resolve = (entry: Entry, seen: Set<number>): GitObject | null => {
    if (seen.has(entry.offset)) return null;
    seen.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) {
      const baseOid = offsetToOid.get(entry.baseOffset);
      if (baseOid !== undefined) base = objects.get(baseOid);
      if (base === undefined) {
        const baseEntry = offsetToEntry.get(entry.baseOffset);
        if (baseEntry !== undefined && (baseEntry.type === 'ofs-delta' || baseEntry.type === 'ref-delta')) {
          base = resolve(baseEntry, seen) ?? undefined;
        }
      }
    } else if (entry.type === 'ref-delta' && entry.baseOid !== undefined) {
      base = objects.get(entry.baseOid) ?? opts?.resolveBase?.(entry.baseOid);
      if (base === undefined) {
        const baseEntry = entries.find((e) => {
          if (e.type === 'ofs-delta' || e.type === 'ref-delta') return false;
          return objectId(e.type, e.data) === entry.baseOid;
        });
        if (baseEntry !== undefined) base = { type: baseEntry.type as ObjType, data: baseEntry.data };
      }
    }
    if (base === undefined) return null;
    const result = applyDelta(base.data, entry.data);
    if (result === null) return null;
    return { type: base.type, data: result };
  };
  for (const entry of entries) {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') continue;
    const resolved = resolve(entry, new Set());
    if (resolved === null) continue;
    const oid = objectId(resolved.type, resolved.data);
    objects.set(oid, resolved);
    offsetToOid.set(entry.offset, oid);
  }
  return { objects, deltaCount };
}

/**
 * Inflate one zlib stream starting at `offset`; returns its bytes and the
 * offset just past the stream. `inflateSync(..., { info: true })` reports the
 * input bytes consumed as engine.bytesWritten, so one inflate per object.
 */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (base-size, result-size, copy/insert ops) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (pos < delta.length) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) return null;
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const opcode = delta[pos++];
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (opcode & (1 << i)) offset |= delta[pos++] << (i * 8);
      }
      for (let i = 0; i < 3; i++) {
        if (opcode & (0x10 << i)) size |= delta[pos++] << (i * 8);
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) return null;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (opcode > 0) {
      if (pos + opcode > delta.length) return null;
      out.push(delta.subarray(pos, pos + opcode));
      outLen += opcode;
      pos += opcode;
    } else {
      return null;
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || outLen !== resultSize) return null;
  return result;
}

/** The zero oid, re-exported for callers that only import git.ts. */
export { ZERO_OID };
