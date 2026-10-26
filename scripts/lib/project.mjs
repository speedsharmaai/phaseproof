import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

export function toProjectPath(root, file) {
  const rel = relative(resolve(root), resolve(root, file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

const FOLDS_CASE = process.platform === 'darwin' || process.platform === 'win32';
const nfc = (s) => s.normalize('NFC');
export const samePath = (a, b, folds = FOLDS_CASE) => (folds ? nfc(a).toLowerCase() === nfc(b).toLowerCase() : nfc(a) === nfc(b));

export function linkedPath(root, rel) {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function exactCase(root, rel) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    try {
      if (!readdirSync(join(root, ...parts.slice(0, i))).some((name) => nfc(name) === nfc(parts[i]))) return false;
    } catch {
      return false;
    }
  }
  return true;
}
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

const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function loadConfig(root) {
  const raw = readJson(ppPath(root, 'config.json'), {});
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  return { ...config, checks: strings(config.checks) ? config.checks : [], docPaths: strings(config.docPaths) ? config.docPaths : DEFAULT_CONFIG.docPaths };
}
export const loadState = (root) => readJson(ppPath(root, 'state.json'), null);

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function phaseDirs(root, phase) {
  const base = join(root, 'phases');
  if (!isDir(base)) return [];
  return readdirSync(base)
    .sort()
    .filter((n) => n === `phase-${phase}` || n.startsWith(`phase-${phase}-`))
    .map((n) => join(base, n))
    .filter(isDir);
}

export function phaseDir(root, phase) {
  return phaseDirs(root, phase)[0] ?? null;
}

function visibleText(md) {
  let text = md.replace(/\r/g, '').replace(/```[\s\S]*?(```|$)/g, '');
  let before;
  do {
    before = text;
    text = text.replace(/<!--[\s\S]*?(-->|$)/g, '');
  } while (text !== before);
  return text;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const cleanPath = (v) =>
  v
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/\s+\(.*\)$/, '')
    .replace(/^`|`$/g, '')
    .replace(/^\.\//, '')
    .trim();

export function scopeList(text, name) {
  const out = [];
  const lines = visibleText(text ?? '').split('\n');
  const head = new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    out.push(...m[1].split(','));
    if (m[1].trim()) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    for (; j < lines.length && BULLET.test(lines[j]); j++) out.push(lines[j].replace(BULLET, ''));
  }
  return out.map(cleanPath).filter((v) => v && v.toLowerCase() !== 'none');
}

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

export function scopeText(root, phase) {
  const dir = phaseDir(root, phase);
  return (dir && readText(join(dir, 'scope.md'))) ?? '';
}

export const lockedTests = (root, phase) => [...new Set(scopeList(scopeText(root, phase), 'Locked tests'))].sort();

export function lockedDigest(root, path) {
  const rel = toProjectPath(root, path);
  if (!rel) return 'outside';
  try {
    return sha256(readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n'));
  } catch {
    return 'missing';
  }
}

export const lockedDigests = (root, phase) => Object.fromEntries(lockedTests(root, phase).map((p) => [p, lockedDigest(root, p)]));

export function changedLocked(root, phase) {
  const locked = readJson(approvalFile(root, phase), null)?.locked;
  if (!locked || typeof locked !== 'object') return [];
  return Object.keys(locked)
    .filter((p) => locked[p] !== lockedDigest(root, p))
    .sort();
}

export function scopeHash(root, phase) {
  const dir = phaseDir(root, phase);
  if (!dir) return null;
  const parts = SCOPE_FILES.map((name) => `${name}\n${readText(join(dir, name)) ?? ''}`);
  for (const path of lockedTests(root, phase)) parts.push(`locked ${path}\n${lockedDigest(root, path)}`);
  return sha256(parts.join('\n---\n'));
}

export function configHash(root) {
  const { checks, docPaths } = loadConfig(root);
  return sha256(JSON.stringify({ checks, docPaths }));
}

export function configChanged(root, phase) {
  const approval = readJson(approvalFile(root, phase), null);
  return Boolean(approval?.configHash) && approval.configHash !== configHash(root);
}

export function scopeChanged(root, phase) {
  const approval = readJson(approvalFile(root, phase), null);
  return Boolean(approval?.scopeHash) && approval.scopeHash !== scopeHash(root, phase);
}

export function gitHead(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout.trim() : null;
}
