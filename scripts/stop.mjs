import { existsSync } from 'node:fs';
import { codeFingerprint, driftSince, isFingerprint } from './lib/drift.mjs';
import { isMain } from './lib/main.mjs';
import { approvalFile, blockFile, gateFile, isActive, loadState, readJson, runFile } from './lib/project.mjs';

export function nudge(root, input) {
  if (input.stop_hook_active === true) return null;
  if (Array.isArray(input.background_tasks) && input.background_tasks.length) return null;
  if (!isActive(root)) return null;
  const phase = loadState(root)?.phase;
  if (typeof phase !== 'string' || !/^\d{1,3}$/.test(phase)) return null;
  if (!existsSync(approvalFile(root, phase)) || existsSync(blockFile(root, phase)) || existsSync(gateFile(root, phase))) return null;
  const run = readJson(runFile(root, phase), null);
  const failing = Array.isArray(run?.results) ? run.results.filter((r) => r?.code !== 0).map((r) => String(r?.cmd)) : [];
  if (!failing.length || !isFingerprint(run.fingerprint)) return null;
  const now = codeFingerprint(root, run.base);
  if (!now) return null;
  const { changed, fresh } = driftSince(run.fingerprint, now);
  if (changed.length || fresh.length) return null;
  return `phaseproof: the last check run for phase ${phase} failed (${failing.slice(0, 3).join(', ')}) and no code has changed since. Fix it before you finish, or tell the owner plainly that the checks are red and why you are stopping.`;
}

export function respond(raw, projectDir = process.env.CLAUDE_PROJECT_DIR) {
  try {
    const input = JSON.parse(raw);
    const reason = nudge(projectDir || input.cwd, input);
    return reason ? JSON.stringify({ decision: 'block', reason }) : '';
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
