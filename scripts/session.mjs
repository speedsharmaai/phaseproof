import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { closedReason } from './lib/decide.mjs';
import { isMain } from './lib/main.mjs';
import { approvalFile, blockFile, gateFile, isActive, loadState, phaseDir, phaseSize, scopeText } from './lib/project.mjs';

const MAX = 1500;

const field = (text, name) => {
  const m = new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'im').exec(text);
  return m ? m[1].trim() : null;
};

export function context(root) {
  if (!isActive(root)) return null;
  const phase = loadState(root)?.phase;
  if (!phase) return null;
  const dir = phaseDir(root, phase);
  const scope = scopeText(root, phase);
  const state = existsSync(blockFile(root, phase))
    ? 'blocked after two failed code reviews, waiting on the owner'
    : existsSync(gateFile(root, phase))
      ? 'gate passed, the next phase needs planning'
      : existsSync(approvalFile(root, phase))
        ? 'approved, building'
        : 'not approved yet, planning';
  const lines = [`phaseproof is active. Current phase: ${phase}${dir ? ` (${dir.split(/[\\/]/).pop()})` : ''}${phaseSize(root, phase) === 'quick' ? ', quick' : ''}. State: ${state}.`];
  const goal = field(scope, 'Goal');
  const done = field(scope, 'Done when');
  if (goal) lines.push(`Goal: ${goal}`);
  if (done) lines.push(`Done when: ${done}`);
  const closed = closedReason(root);
  lines.push(closed ? `Code is closed: ${closed}` : 'Code is open for this phase only. Stay inside its scope.md and tasks.md.');
  if (existsSync(join(root, 'docs', 'learnings.md'))) lines.push('Read docs/learnings.md before planning or reviewing; it lists mistakes earlier phases made.');
  lines.push('Run /phaseproof:status for details.');
  const text = lines.join('\n');
  return text.length > MAX ? `${text.slice(0, MAX - 3)}...` : text;
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
