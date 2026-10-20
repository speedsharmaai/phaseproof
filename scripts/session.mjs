import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { closedReason } from './lib/decide.mjs';
import { isMain } from './lib/main.mjs';
import { approvalFile, blockFile, gateFile, isActive, loadState, phaseDir, readJson, scopeField, scopeText } from './lib/project.mjs';

const MAX = 1500;

const FIELD_MAX = 300;
const field = (text, name) => {
  const value = scopeField(text, name);
  if (!value) return null;
  return value.length > FIELD_MAX ? `${value.slice(0, FIELD_MAX - 3)}...` : value;
};

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
  const lines = [`phaseproof is active. Current phase: ${phase}${dir ? ` (${dir.split(/[\\/]/).pop()})` : ''}${readJson(approvalFile(root, phase), {}).size === 'quick' ? ', approved as quick' : ''}. State: ${state}.`];
  const goal = field(scope, 'Goal');
  const done = field(scope, 'Done when');
  if (goal) lines.push(`Goal: ${goal}`);
  if (done) lines.push(`Done when: ${done}`);
  const closed = closedReason(root);
  lines.push(closed ? `Code is closed: ${closed}` : 'Code is open for this phase only. Stay inside its scope.md and tasks.md.');
  if (existsSync(join(root, 'docs', 'learnings.md'))) lines.push('Read docs/learnings.md before planning or reviewing; it lists mistakes earlier phases made.');
  lines.push('Run /phaseproof:status for details.');
  return lines.join('\n').slice(0, MAX);
}

export function respond(raw, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  try {
    const input = JSON.parse(raw);
    const text = context(projectDir || input.cwd);
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
