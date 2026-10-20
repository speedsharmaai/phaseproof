import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDoc } from './decide.mjs';
import { loadConfig, ppPath, readJson, sha256, writeJson } from './project.mjs';

const MAX_SAVED_BYTES = 5 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

export const guardMode = (root) => {
  const mode = loadConfig(root).shellGuard ?? 'revert';
  return ['revert', 'warn', 'off'].includes(mode) ? mode : 'revert';
};

const snapshotFile = (root, id) => ppPath(root, 'shell', `${String(id).replace(/[^\w.-]/g, '_')}.json`);

export function dirtyCodeFiles(root) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.status !== 0) return null;
  const { docPaths } = loadConfig(root);
  const parts = r.stdout.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    files.push(parts[i].slice(3));
    if (code.includes('R') || code.includes('C')) files.push(parts[++i]);
  }
  return [...new Set(files)].filter((f) => !f.startsWith('.phaseproof/') && !isDoc(f, docPaths));
}

const hashOf = (root, rel) => {
  try {
    return sha256(readFileSync(join(root, rel)));
  } catch {
    return null;
  }
};

function pruneStale(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (Date.now() - statSync(file).mtimeMs > STALE_MS) rmSync(file, { force: true });
  }
}

export function snapshot(root, id) {
  if (!id || guardMode(root) === 'off') return false;
  const files = dirtyCodeFiles(root);
  if (!files) return false;
  pruneStale(ppPath(root, 'shell'));
  let budget = MAX_SAVED_BYTES;
  const entries = files.map((rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return { rel, hash: null };
    const data = readFileSync(path);
    const keep = data.length <= budget;
    if (keep) budget -= data.length;
    return { rel, hash: sha256(data), content: keep ? data.toString('base64') : undefined };
  });
  writeJson(snapshotFile(root, id), { at: new Date().toISOString(), entries });
  return true;
}

const inHead = (root, rel) => git(root, ['cat-file', '-e', `HEAD:${rel}`]).status === 0;

function restore(root, rel, before) {
  const path = join(root, rel);
  if (before) {
    if (before.hash === null) {
      rmSync(path, { force: true });
      return true;
    }
    if (before.content === undefined) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(before.content, 'base64'));
    return true;
  }
  if (inHead(root, rel)) return git(root, ['checkout', 'HEAD', '--', rel]).status === 0;
  if (existsSync(path)) unlinkSync(path);
  return true;
}

export function verify(root, id) {
  const file = snapshotFile(root, id);
  const snap = readJson(file, null);
  if (!snap) return null;
  rmSync(file, { force: true });
  const now = dirtyCodeFiles(root);
  if (!now) return null;

  const before = new Map(snap.entries.map((e) => [e.rel, e]));
  const candidates = [...new Set([...now, ...before.keys()])];
  const changed = candidates.filter((rel) => !before.has(rel) || hashOf(root, rel) !== before.get(rel).hash).sort();
  if (!changed.length) return null;

  const mode = guardMode(root);
  if (mode !== 'revert') return { mode, changed, restored: [], kept: changed, quarantine: null };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = `.phaseproof/quarantine/${stamp}`;
  const restored = [];
  const kept = [];
  for (const rel of changed) {
    const path = join(root, rel);
    if (existsSync(path)) {
      const target = join(root, quarantine, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path));
    }
    (restore(root, rel, before.get(rel)) ? restored : kept).push(rel);
  }
  return { mode, changed, restored, kept, quarantine };
}

export function describeViolation(phaseReason, result) {
  const list = (files) => files.slice(0, 10).join(', ') + (files.length > 10 ? ` and ${files.length - 10} more` : '');
  const lines = [`phaseproof: that shell command changed code while code is closed (${list(result.changed)}).`];
  if (result.mode === 'warn') {
    lines.push('Nothing was rolled back because shellGuard is set to "warn".');
  } else {
    if (result.restored.length) lines.push(`Rolled back: ${list(result.restored)}. The shell's version is saved in ${result.quarantine}/.`);
    if (result.kept.length) lines.push(`Could not roll back (too large to snapshot): ${list(result.kept)}. Check them by hand.`);
  }
  lines.push(`Why code is closed: ${phaseReason.replace(/^phaseproof: /, '')}`);
  return lines.join(' ');
}
