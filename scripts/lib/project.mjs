import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const DIR = '.phaseproof';

export const DEFAULT_CONFIG = {
  checks: [],
  docPaths: ['docs/', 'phases/', 'design/'],
};

export function padPhase(id) {
  const n = String(id ?? '').trim().replace(/^phase-/, '');
  if (!/^\d{1,3}$/.test(n)) throw new Error(`not a phase number: ${id}`);
  return n.padStart(2, '0');
}

export const ppPath = (root, ...parts) => join(root, DIR, ...parts);
export const isActive = (root) => Boolean(root) && existsSync(ppPath(root, 'state.json'));

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const loadConfig = (root) => ({ ...DEFAULT_CONFIG, ...readJson(ppPath(root, 'config.json'), {}) });
export const loadState = (root) => readJson(ppPath(root, 'state.json'), null);

export function phaseDirs(root, phase) {
  const base = join(root, 'phases');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .filter((n) => n === `phase-${phase}` || n.startsWith(`phase-${phase}-`))
    .map((n) => join(base, n));
}

export function phaseDir(root, phase) {
  return phaseDirs(root, phase)[0] ?? null;
}

const visibleText = (md) => md.replace(/```[\s\S]*?```/g, '').replace(/<!--[\s\S]*?-->/g, '');

export function scopeField(text, name) {
  const m = new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'm').exec(visibleText(text ?? ''));
  return m ? m[1].trim() : null;
}

export const approvalFile = (root, phase) => ppPath(root, 'approvals', `phase-${phase}.json`);
export const gateFile = (root, phase) => ppPath(root, 'gates', `phase-${phase}.json`);
export const reviewFile = (root, phase, kind) => ppPath(root, 'reviews', `phase-${phase}-${kind}.md`);
export const runFile = (root, phase) => ppPath(root, 'runs', `phase-${phase}-checks.json`);
export const blockFile = (root, phase) => ppPath(root, 'blocks', `phase-${phase}.json`);

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const SCOPE_FILES = ['scope.md', 'tasks.md', 'screens.md'];

export function scopeHash(root, phase) {
  const dir = phaseDir(root, phase);
  if (!dir) return null;
  const parts = SCOPE_FILES.map((name) => `${name}\n${readText(join(dir, name)) ?? ''}`);
  return sha256(parts.join('\n---\n'));
}

export function phaseSize(root, phase) {
  const dir = phaseDir(root, phase);
  const scope = dir ? readText(join(dir, 'scope.md')) : null;
  return scopeField(scope, 'Size') === 'quick' ? 'quick' : 'full';
}

export function scopeText(root, phase) {
  const dir = phaseDir(root, phase);
  return (dir && readText(join(dir, 'scope.md'))) ?? '';
}

export function scopeChanged(root, phase) {
  const approval = readJson(approvalFile(root, phase), null);
  return Boolean(approval?.scopeHash) && approval.scopeHash !== scopeHash(root, phase);
}

export function gitHead(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
