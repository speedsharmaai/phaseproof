import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDoc } from './decide.mjs';
import { loadConfig, ppPath, readJson, sha256, writeJson } from './project.mjs';

const MAX_SAVED_BYTES = 5 * 1024 * 1024;
const MAX_HASHED_BYTES = 20 * 1024 * 1024;
const PENDING_MS = 10 * 60 * 1000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CHUNK = 200;

const git = (cwd, args, input) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd, input: input === undefined ? undefined : Buffer.from(input), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

export const guardMode = (root) => {
  const mode = loadConfig(root).shellGuard ?? 'revert';
  return ['revert', 'warn', 'off'].includes(mode) ? mode : 'revert';
};

const snapshotDir = (root) => ppPath(root, 'shell');
const snapshotFile = (root, id) => join(snapshotDir(root), `${String(id).replace(/[^\w.-]/g, '_')}.json`);

function repoState(root) {
  const r = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.status !== 0) return null;
  const [top, prefix = ''] = r.stdout.toString('utf8').split('\n');
  const head = git(root, ['rev-parse', '-q', '--verify', 'HEAD']);
  return { top, prefix, head: head.status === 0 ? head.stdout.toString('utf8').trim() : null };
}

function changedPaths(root, state) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (r.status !== 0) return null;
  const parts = r.stdout.toString('utf8').split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    paths.push(parts[i].slice(3));
    if (code.includes('R') || code.includes('C')) paths.push(parts[++i]);
  }
  return toCode(root, state, paths);
}

function toCode(root, state, topPaths) {
  const { docPaths } = loadConfig(root);
  const out = new Set();
  for (const p of topPaths) {
    if (!p.startsWith(state.prefix)) continue;
    const rel = p.slice(state.prefix.length).replace(/\/$/, '');
    if (rel && !rel.startsWith('.phaseproof/') && rel !== '.phaseproof' && !isDoc(rel, docPaths)) out.add(rel);
  }
  return [...out];
}

export function dirtyCodeFiles(root) {
  const state = repoState(root);
  return state ? changedPaths(root, state) : null;
}

function describe(root, rel) {
  let st;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return { rel, kind: 'gone' };
  }
  if (st.isSymbolicLink()) return { rel, kind: 'symlink', target: readlinkSync(join(root, rel)) };
  if (!st.isFile()) return { rel, kind: 'other' };
  if (st.size > MAX_HASHED_BYTES) return { rel, kind: 'file', size: st.size, mtime: st.mtimeMs };
  return { rel, kind: 'file', size: st.size, hash: sha256(readFileSync(join(root, rel))) };
}

const sameState = (a, b) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'symlink') return a.target === b.target;
  if (a.kind !== 'file') return true;
  return a.hash !== undefined ? a.hash === b.hash : a.size === b.size && a.mtime === b.mtime;
};

function prune(dir, ttl) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > ttl) rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

function pendingOthers(root, own) {
  const dir = snapshotDir(root);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => {
    const path = join(dir, name);
    if (path === own) return false;
    try {
      return Date.now() - statSync(path).mtimeMs < PENDING_MS;
    } catch {
      return false;
    }
  });
}

function ensureIgnored(root) {
  const file = ppPath(root, '.gitignore');
  const want = ['shell/', 'quarantine/'];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {}
  const missing = want.filter((line) => !text.split(/\r?\n/).includes(line));
  if (missing.length) writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

export function snapshot(root, id, { background = false } = {}) {
  if (!id || background || guardMode(root) === 'off') return false;
  const state = repoState(root);
  if (!state) return false;
  const paths = changedPaths(root, state);
  if (!paths) return false;
  ensureIgnored(root);
  prune(snapshotDir(root), SNAPSHOT_TTL_MS);
  prune(ppPath(root, 'quarantine'), QUARANTINE_TTL_MS);

  const entries = paths.map((rel) => describe(root, rel)).sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  let budget = MAX_SAVED_BYTES;
  for (const e of entries) {
    if (e.kind !== 'file' || e.hash === undefined || e.size > budget) continue;
    try {
      e.content = readFileSync(join(root, e.rel)).toString('base64');
      budget -= e.size;
    } catch {}
  }
  const file = snapshotFile(root, id);
  mkdirSync(snapshotDir(root), { recursive: true });
  writeJson(file, { at: new Date().toISOString(), head: state.head, concurrent: pendingOthers(root, file), entries });
  return true;
}

function inHead(root, state, rels) {
  if (!state.head || !rels.length) return new Set();
  const input = rels.map((rel) => `HEAD:${state.prefix}${rel}`).join('\n') + '\n';
  const r = git(root, ['cat-file', '--batch-check'], input);
  if (r.status !== 0) return new Set();
  const lines = r.stdout.toString('utf8').split('\n');
  return new Set(rels.filter((_, i) => lines[i] && !lines[i].endsWith(' missing')));
}

function inChunks(rels, run) {
  const failed = [];
  for (let i = 0; i < rels.length; i += CHUNK) {
    const chunk = rels.slice(i, i + CHUNK);
    if (run(chunk).status === 0) continue;
    for (const rel of chunk) if (run([rel]).status !== 0) failed.push(rel);
  }
  return failed;
}

function removeEmptyParents(root, rel) {
  let dir = dirname(rel);
  while (dir && dir !== '.') {
    try {
      rmdirSync(join(root, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

function committedCode(root, state, from) {
  if (!from || !state.head) return [];
  const r = git(state.top, ['diff', '--name-only', '-z', from, state.head]);
  if (r.status !== 0) return [];
  return toCode(root, state, r.stdout.toString('utf8').split('\0').filter(Boolean));
}

export function verify(root, id) {
  const file = snapshotFile(root, id);
  const snap = readJson(file, null);
  if (!snap) return null;
  const state = repoState(root);
  const paths = state && changedPaths(root, state);
  if (!paths) {
    rmSync(file, { force: true });
    return null;
  }

  if (snap.head !== state.head) {
    rmSync(file, { force: true });
    const committed = committedCode(root, state, snap.head);
    return committed.length ? { mode: 'head-moved', changed: committed } : null;
  }

  const before = new Map(snap.entries.map((e) => [e.rel, e]));
  const candidates = [...new Set([...paths, ...before.keys()])].sort();
  const changed = [];
  const unchecked = [];
  for (const rel of candidates) {
    const now = describe(root, rel);
    const prev = before.get(rel);
    if (prev ? sameState(prev, now) : false) continue;
    if (now.kind === 'symlink' || now.kind === 'other' || prev?.kind === 'symlink' || prev?.kind === 'other') unchecked.push(rel);
    else changed.push(rel);
  }
  if (!changed.length && !unchecked.length) {
    rmSync(file, { force: true });
    return null;
  }

  const configured = guardMode(root);
  const concurrent = snap.concurrent || pendingOthers(root, file);
  if (configured !== 'revert' || concurrent || !changed.length) {
    rmSync(file, { force: true });
    return { mode: concurrent && configured === 'revert' ? 'concurrent' : 'warn', changed, unchecked };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = `.phaseproof/quarantine/${stamp}`;
  const qroot = join(root, quarantine);
  mkdirSync(qroot, { recursive: true });
  writeJson(join(qroot, 'snapshot-before.json'), snap);
  rmSync(file, { force: true });

  const failed = [];
  const safe = [];
  for (const rel of changed) {
    try {
      const path = join(root, rel);
      if (existsSync(path)) {
        mkdirSync(dirname(join(qroot, rel)), { recursive: true });
        writeFileSync(join(qroot, rel), readFileSync(path));
      }
      safe.push(rel);
    } catch (e) {
      failed.push({ rel, why: `could not save a copy (${e.code ?? e.message})` });
    }
  }

  const restored = [];
  const toCheckout = [];
  const toUnstage = [];
  const head = inHead(root, state, safe.filter((rel) => !before.has(rel)));
  for (const rel of safe) {
    const prev = before.get(rel);
    const path = join(root, rel);
    try {
      if (!prev) {
        if (head.has(rel)) {
          toCheckout.push(rel);
          continue;
        }
        rmSync(path, { force: true });
        removeEmptyParents(root, rel);
        toUnstage.push(rel);
        restored.push(rel);
      } else if (prev.kind === 'gone') {
        rmSync(path, { force: true });
        restored.push(rel);
      } else if (prev.content !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(prev.content, 'base64'));
        restored.push(rel);
      } else {
        failed.push({ rel, why: 'too large to snapshot' });
      }
    } catch (e) {
      failed.push({ rel, why: `restore failed (${e.code ?? e.message})` });
    }
  }

  const top = (rels) => rels.map((rel) => `${state.prefix}${rel}`);
  const checkoutFailed = new Set(inChunks(toCheckout, (c) => git(state.top, ['checkout', 'HEAD', '--', ...top(c)])));
  for (const rel of toCheckout) {
    if (checkoutFailed.has(rel)) failed.push({ rel, why: 'git checkout failed' });
    else restored.push(rel);
  }
  if (toUnstage.length) inChunks(toUnstage, (c) => git(state.top, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...top(c)]));

  return { mode: 'revert', changed, restored: restored.sort(), failed, unchecked, quarantine };
}

const list = (files) => files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');

export function describeViolation(phaseReason, result) {
  const why = `Why code is closed: ${phaseReason.replace(/^phaseproof: /, '')}`;
  if (result.mode === 'head-moved') {
    return `phaseproof: that command moved HEAD (a commit, reset or checkout), and code now differs from before it while code is closed (${list(result.changed)}). Nothing was rolled back. Check git log and undo it if it should not be there. ${why}`;
  }
  const lines = [];
  if (result.changed.length) lines.push(`phaseproof: that shell command changed code while code is closed (${list(result.changed)}).`);
  if (result.mode === 'warn') lines.push('Nothing was rolled back because shellGuard is set to "warn".');
  if (result.mode === 'concurrent') lines.push('Nothing was rolled back because another shell command was running at the same time, so the change could not be pinned on this one.');
  if (result.mode === 'revert') {
    if (result.restored.length) lines.push(`Rolled back: ${list(result.restored)}. The shell's version and the state from before the command are saved in ${result.quarantine}/.`);
    for (const f of result.failed) lines.push(`Not rolled back: ${f.rel}, ${f.why}. Check it by hand.`);
  }
  if (result.unchecked?.length) lines.push(`${lines.length ? '' : 'phaseproof: '}Symlinks and directories are not checked: ${list(result.unchecked)}.`);
  lines.push(why);
  return lines.join(' ');
}
