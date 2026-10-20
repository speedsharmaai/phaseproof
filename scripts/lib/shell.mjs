import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDoc } from './decide.mjs';
import { loadConfig, ppPath, readJson, sha256 } from './project.mjs';

const MAX_HASHED_BYTES = 1024 * 1024;
const MAX_HASHED_FILES = 2000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const git = (cwd, args) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

const snapshotDir = (root) => ppPath(root, 'shell');
const snapshotFile = (root, id) => join(snapshotDir(root), `${String(id).replace(/[^\w.-]/g, '_')}.json`);

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

function describe(root, rel, hash) {
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return { rel, kind: 'gone' };
  }
  if (st.isSymbolicLink()) return { rel, kind: 'link', target: readlinkSync(join(root, rel)) };
  if (!st.isFile()) return { rel, kind: 'other' };
  if (!hash || st.size > MAX_HASHED_BYTES) return { rel, kind: 'file', size: st.size, mtime: st.mtimeMs };
  try {
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
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    try {
      if (Date.now() - statSync(join(dir, name)).mtimeMs > SNAPSHOT_TTL_MS) rmSync(join(dir, name), { force: true });
    } catch {}
  }
}

function ensureIgnored(root) {
  const file = ppPath(root, '.gitignore');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  if (text.split(/\r?\n/).includes('shell/')) return;
  writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}shell/\n`);
}

export function snapshot(root, id, { background = false } = {}) {
  if (!id || background) return false;
  const state = repoState(root);
  if (!state) return false;
  const { docPaths } = loadConfig(root);
  const paths = changedPaths(root, state, docPaths);
  if (!paths) return false;
  mkdirSync(snapshotDir(root), { recursive: true });
  ensureIgnored(root);
  prune(snapshotDir(root));
  const hash = paths.length <= MAX_HASHED_FILES;
  const entries = paths.map((rel) => describe(root, rel, hash));
  const file = snapshotFile(root, id);
  writeFileSync(`${file}.tmp`, JSON.stringify({ at: new Date().toISOString(), head: state.head, docPaths, hash, entries }));
  renameSync(`${file}.tmp`, file);
  return true;
}

function committedCode(root, state, docPaths, from) {
  if (!state.head) return [];
  const r = git(state.top, ['diff', '--name-only', '-z', from ?? EMPTY_TREE, state.head]);
  if (r.status !== 0) return [];
  return toCode(state, docPaths, r.stdout.toString('utf8').split('\0').filter(Boolean));
}

export function verify(root, id) {
  const file = snapshotFile(root, id);
  const snap = readJson(file, null);
  rmSync(file, { force: true });
  if (!snap || !Array.isArray(snap.entries)) return null;
  const state = repoState(root);
  if (!state) return null;
  const docPaths = Array.isArray(snap.docPaths) ? snap.docPaths : loadConfig(root).docPaths;

  const committed = snap.head !== state.head ? committedCode(root, state, docPaths, snap.head) : [];
  const paths = changedPaths(root, state, docPaths) ?? [];
  const before = new Map(snap.entries.map((e) => [e.rel, e]));
  const changed = [...paths]
    .sort()
    .filter((rel) => {
      const prev = before.get(rel);
      return !prev || !same(prev, describe(root, rel, snap.hash !== false));
    });
  if (!changed.length && !committed.length) return null;
  return { changed, committed, headMoved: snap.head !== state.head };
}

const list = (files) => files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');

export function describeViolation(phaseReason, result) {
  const lines = [];
  if (result.changed.length) lines.push(`phaseproof: code changed during that shell command while code is closed: ${list(result.changed)}.`);
  if (result.committed.length) lines.push(`${lines.length ? 'It' : 'phaseproof: that shell command'} also moved HEAD, and the new commits change code: ${list(result.committed)}.`);
  lines.push('phaseproof did not touch any file. Undo these changes, or stop and tell the owner why they are needed.');
  lines.push(`Why code is closed: ${phaseReason.replace(/^phaseproof: /, '')}`);
  return lines.join(' ');
}

export function ownerNotice(result) {
  const files = [...new Set([...result.changed, ...result.committed])];
  return `phaseproof: a shell command changed code while the phase is closed (${list(files)}). Claude was told to undo it.`;
}
