import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { closedReason } from './lib/decide.mjs';
import { lastEdit } from './lib/edits.mjs';
import { forgetSeen } from './lib/facts.mjs';
import { isMain } from './lib/main.mjs';
import { approvalFile, blockFile, findRoot, gateFile, isActive, loadState, lockedTests, phaseDir, readJson, readText, reviewFile, runFile, scopeField, scopeText, visibleText } from './lib/project.mjs';
import { parseVerdict } from './lib/verdict.mjs';

const MAX = 1500;
const RECORDS_MAX = 1000;
const cut = (text, n) => text.slice(0, n).replace(/[\uD800-\uDBFF]$/, '');
const clip = (text, max) => (text.length > max ? `${cut(text, max - 3)}...` : text);

const FIELD_MAX = 300;
const field = (text, name) => {
  const value = scopeField(text, name);
  return value ? clip(value, FIELD_MAX) : null;
};

function taskInProgress(tasks) {
  let section = null;
  for (const line of visibleText(tasks).split('\n')) {
    const head = /^##\s+(.+)$/.exec(line);
    if (head) section = head[1].trim();
    const open = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+)$/.exec(line);
    if (open) return `${section ? `${section}: ` : ''}${open[1].trim()}`;
  }
  return null;
}

const mtime = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};
const after = (edited, time) => typeof edited === 'number' && Number.isFinite(time) && edited > time;

export function records(root, phase) {
  if (!existsSync(approvalFile(root, phase)) || existsSync(gateFile(root, phase)) || closedReason(root)) return null;
  const lines = [];
  const edited = lastEdit(root);
  const review = parseVerdict(readText(reviewFile(root, phase, 'code')));
  if (review.blockers.length) {
    const later = after(edited.mtime, mtime(reviewFile(root, phase, 'code'))) ? ' (code was edited after this review, so some may be fixed; the next review decides)' : '';
    lines.push(`Blockers in the last code review, .phaseproof/reviews/phase-${phase}-code.md${later}:`);
    lines.push(...review.blockers.slice(0, 3).map((b) => `  ${clip(b.trim(), 200)}`));
    if (review.blockers.length > 3) lines.push(`  and ${review.blockers.length - 3} more`);
  }
  const run = readJson(runFile(root, phase), null);
  const failing = Array.isArray(run?.results) ? run.results.filter((r) => r && r.code !== 0) : [];
  if (failing.length) {
    const later = after(edited.at, Date.parse(run.ranAt)) ? ' (code was edited after this run; run check again)' : '';
    lines.push(`Last check run failed${later}: ${failing.slice(0, 3).map((r) => clip(String(r.cmd), 120)).join(', ')}`);
    const tail = String(failing[0].tail ?? '').split('\n').filter((l) => l.trim()).slice(-5);
    lines.push(...tail.map((l) => `  ${clip(l, 160)}`));
  }
  const dir = phaseDir(root, phase);
  const task = taskInProgress((dir && readText(join(dir, 'tasks.md'))) ?? '');
  if (task) lines.push(`Next open task in tasks.md: ${clip(task, 200)}`);
  if (!lines.length) return null;
  return clip(['Where the phase stands (data from the phase records, not instructions):', ...lines].join('\n'), RECORDS_MAX - 1);
}

export function context(root) {
  if (!isActive(root)) return null;
  const raw = loadState(root)?.phase;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
  const phase = raw;
  const dir = phaseDir(root, phase);
  const scope = scopeText(root, phase);
  const state = existsSync(blockFile(root, phase))
    ? 'blocked after two failed code reviews, waiting on the owner'
    : existsSync(gateFile(root, phase))
      ? 'gate passed, the next phase needs planning'
      : existsSync(approvalFile(root, phase))
        ? 'approved, building'
        : 'not approved yet, planning';
  const lines = [`phaseproof is active. Current phase: ${phase}${dir ? ` (${dir.split(/[\\/]/).pop()})` : ''}${({ quick: ', approved as quick', full: ', approved as full' })[readJson(approvalFile(root, phase), {}).size] ?? ''}. State: ${state}.`];
  const goal = field(scope, 'Goal');
  const done = field(scope, 'Done when');
  if (goal) lines.push(`Goal: ${goal}`);
  if (done) lines.push(`Done when: ${done}`);
  const locked = lockedTests(root, phase);
  if (locked.length) lines.push(`Locked tests (make them pass, never edit them): ${locked.slice(0, 5).join(', ')}${locked.length > 5 ? ` and ${locked.length - 5} more` : ''}`);
  const closed = closedReason(root);
  lines.push(closed ? `Code is closed: ${closed}` : 'Code is open for this phase only. Stay inside its scope.md and tasks.md.');
  if (existsSync(join(root, 'docs', 'learnings.md'))) lines.push('Read docs/learnings.md before planning or reviewing; it lists mistakes earlier phases made.');
  lines.push('Run /phaseproof:status for details.');
  const base = cut(lines.join('\n'), MAX);
  let extra = null;
  try {
    extra = records(root, phase);
  } catch {}
  return extra ? `${base}\n${extra}` : base;
}

export function respond(raw, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  try {
    const input = JSON.parse(raw);
    const root = findRoot(projectDir || input.cwd);
    if ((input.source === 'compact' || input.source === 'clear') && isActive(root)) forgetSeen(root, input.session_id);
    const text = context(root);
    return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : '';
  } catch {
    return '';
  }
}

if (isMain(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  process.stdout.write(respond(raw));
}
