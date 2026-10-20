import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDoc } from './decide.mjs';
import { loadConfig, readJson, sha256 } from './project.mjs';

const MAX_HASHED_BYTES = 1024 * 1024;
const MAX_HASHED_FILES = 2000;
const MAX_HASHED_TOTAL = 64 * 1024 * 1024;
const OWN_FILE = /^[0-9a-f]{12}-[\w.-]+\.json(\.tmp)?$/;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

const git = (cwd, args, input) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd, input, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

const isRealDir = (path) => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

export function storeDir(root) {
  const r = git(root, ['rev-parse', '--git-path', 'phaseproof']);
  if (r.status !== 0) return null;
  const dir = resolve(root, r.stdout.toString('utf8').trim());
  if (existsSync(dir) || isLink(dir)) return isRealDir(dir) ? dir : null;
  return dir;
}

const projectKey = (root) => sha256(resolve(root)).slice(0, 12);
const snapshotFile = (dir, root, id) => join(dir, `${projectKey(root)}-${String(id).replace(/[^\w.-]/g, '_')}.json`);

function repoState(root) {
  const r = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.status !== 0) return null;
  const [top, prefix = ''] = r.stdout.toString('utf8').split('\n');
  const head = git(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  return { top, prefix, head: head.status === 0 ? head.stdout.toString('utf8').trim() : null };
}

function toCode(state, docPaths, topPaths) {
  const out = new Set();
  for (const p of topPaths) {
    if (!p.startsWith(state.prefix)) continue;
    const rel = p.slice(state.prefix.length).replace(/\/$/, '');
    if (rel && rel !== '.phaseproof' && !rel.startsWith('.phaseproof/') && !isDoc(rel, docPaths)) out.add(rel);
  }
  return [...out];
}

function changedPaths(root, state, docPaths) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (r.status !== 0) return null;
  const parts = r.stdout.toString('utf8').split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    paths.push(parts[i].slice(3));
    if (code.includes('R') || code.includes('C')) paths.push(parts[++i]);
  }
  return toCode(state, docPaths, paths);
}

export function dirtyCodeFiles(root) {
  const state = repoState(root);
  return state ? changedPaths(root, state, loadConfig(root).docPaths) : null;
}

function describe(root, rel, budget) {
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return { rel, kind: 'gone' };
  }
  if (st.isSymbolicLink()) return { rel, kind: 'link', target: readlinkSync(join(root, rel)) };
  if (!st.isFile()) return { rel, kind: 'other' };
  if (!budget || st.size > MAX_HASHED_BYTES || budget.left < st.size) return { rel, kind: 'file', size: st.size, mtime: st.mtimeMs };
  try {
    budget.left -= st.size;
    return { rel, kind: 'file', hash: sha256(readFileSync(join(root, rel))) };
  } catch {
    return { rel, kind: 'file', size: st.size, mtime: st.mtimeMs };
  }
}

const same = (a, b) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'link') return a.target === b.target;
  if (a.kind !== 'file') return true;
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash;
  return a.size === b.size && a.mtime === b.mtime;
};

function prune(dir) {
  if (!isRealDir(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!OWN_FILE.test(name)) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile() && Date.now() - st.mtimeMs > SNAPSHOT_TTL_MS) rmSync(join(dir, name), { force: true });
    } catch {}
  }
}

export function snapshot(root, id, { background = false } = {}) {
  if (!id || background) return false;
  const dir = storeDir(root);
  if (!dir) return false;
  const state = repoState(root);
  if (!state) return false;
  const { docPaths } = loadConfig(root);
  const paths = changedPaths(root, state, docPaths);
  if (!paths) return false;
  mkdirSync(dir, { recursive: true });
  if (!isRealDir(dir)) return false;
  prune(dir);
  const hash = paths.length <= MAX_HASHED_FILES;
  const budget = hash ? { left: MAX_HASHED_TOTAL } : null;
  const entries = paths.map((rel) => describe(root, rel, budget));
  const file = snapshotFile(dir, root, id);
  rmSync(`${file}.tmp`, { force: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ at: new Date().toISOString(), head: state.head, docPaths, hash, entries }), { flag: 'wx' });
  renameSync(`${file}.tmp`, file);
  return true;
}

function emptyTree(root) {
  const r = git(root, ['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0));
  return r.status === 0 ? r.stdout.toString('utf8').trim() : null;
}

function headBlobHashes(state, rels) {
  const out = new Map();
  if (!state.head || !rels.length) return out;
  const input = rels.map((rel) => `${state.head}:${state.prefix}${rel}`).join('\n') + '\n';
  const r = git(state.top, ['cat-file', '--batch'], Buffer.from(input));
  if (r.status !== 0) return out;
  const buf = r.stdout;
  let at = 0;
  for (const rel of rels) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    at = nl + 1;
    if (header[1] !== 'blob') continue;
    const size = Number(header[2]);
    out.set(rel, sha256(buf.subarray(at, at + size)));
    at += size + 1;
  }
  return out;
}

function committedCode(root, state, docPaths, from) {
  if (!state.head) return [];
  const base = from ?? emptyTree(root);
  if (!base) return [];
  const r = git(state.top, ['diff', '--name-only', '--no-renames', '-z', base, state.head]);
  if (r.status !== 0) return [];
  return toCode(state, docPaths, r.stdout.toString('utf8').split('\0').filter(Boolean));
}

export function verify(root, id) {
  const dir = storeDir(root);
  if (!dir) return null;
  const file = snapshotFile(dir, root, id);
  if (isLink(file)) return null;
  const snap = readJson(file, null);
  try {
    return snap && Array.isArray(snap.entries) ? compare(root, snap) : null;
  } finally {
    rmSync(file, { force: true });
  }
}

function compare(root, snap) {
  const state = repoState(root);
  if (!state) return null;
  const docPaths = Array.isArray(snap.docPaths) ? snap.docPaths : loadConfig(root).docPaths;

  const committed = snap.head !== state.head ? committedCode(root, state, docPaths, snap.head) : [];
  const paths = changedPaths(root, state, docPaths) ?? [];
  const before = new Map(snap.entries.map((e) => [e.rel, e]));
  const budget = snap.hash !== false ? { left: MAX_HASHED_TOTAL } : null;
  const changed = [...paths].sort().filter((rel) => {
    const prev = before.get(rel);
    return !prev || !same(prev, describe(root, rel, prev?.hash !== undefined ? budget : null));
  });
  const now = new Set(paths);
  const gone = [...before.keys()].filter((rel) => {
    const prev = before.get(rel);
    return !now.has(rel) && !same(prev, describe(root, rel, prev.hash !== undefined ? { left: MAX_HASHED_TOTAL } : null));
  });
  const inHead = headBlobHashes(state, gone.filter((rel) => before.get(rel).hash !== undefined));
  const discarded = gone.filter((rel) => inHead.get(rel) !== before.get(rel).hash).sort();
  const overwritten = changed.filter((rel) => before.has(rel));
  if (!changed.length && !committed.length && !discarded.length) return null;
  return { changed, committed, discarded, overwritten };
}

const list = (files) => files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');

const shortReason = (reason) => `${reason.replace(/^phaseproof: /, '').split(/\.\s/)[0].replace(/\.$/, '')}.`;

export function describeViolation(phaseReason, result) {
  const lines = [];
  if (result.changed.length) lines.push(`phaseproof: code changed during that shell command while code is closed: ${list(result.changed)}.`);
  if (result.overwritten?.length) lines.push(`phaseproof: these files already had the owner's uncommitted changes, and the command overwrote them: ${list(result.overwritten)}.`);
  if (result.discarded?.length) lines.push(`phaseproof: uncommitted changes that existed before the command are gone now: ${list(result.discarded)}.`);
  if (result.committed.length) lines.push(`phaseproof: HEAD moved during that command (commit, reset or checkout), and the code it points to differs from before: ${list(result.committed)}.`);
  lines.push('phaseproof did not touch any file. Do not modify, restore, move or delete these files, and do not run git checkout, restore, reset, stash or clean to "fix" this.');
  lines.push('Stop, tell the owner exactly what you ran, and wait for their decision.');
  lines.push(`Code is closed because ${shortReason(phaseReason)}`);
  return lines.join(' ');
}

export function ownerNotice(result) {
  const parts = [];
  const overwritten = result.overwritten ?? [];
  const plain = result.changed.filter((rel) => !overwritten.includes(rel));
  if (plain.length) parts.push(`changed ${list(plain)}`);
  if (overwritten.length) parts.push(`overwrote your uncommitted changes in ${list(overwritten)}`);
  if (result.discarded?.length) parts.push(`wiped your uncommitted changes in ${list(result.discarded)}`);
  if (result.committed.length) parts.push(`moved HEAD, so the committed code in ${list(result.committed)} is different`);
  return `phaseproof: while the phase is closed, a shell command ${parts.join('; ')}. phaseproof did not touch any file. Claude was asked to stop and wait for you.`;
}
