import { spawnSync } from 'node:child_process';

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export function runChecks(root, commands, spawn = spawnSync, timeoutMs = CHECK_TIMEOUT_MS) {
  return commands.map((cmd) => {
    const started = Date.now();
    const r = spawn(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    const lines = out.split(/\r?\n/).slice(-20);
    if (r.error?.code === 'ETIMEDOUT') lines.push(`phaseproof: timed out after ${Math.round(timeoutMs / 1000)} s and was stopped`);
    else if (r.error) lines.push(`phaseproof: ${r.error.message}`);
    return {
      cmd,
      code: typeof r.status === 'number' ? r.status : 1,
      ms: Date.now() - started,
      tail: lines.join('\n').trim(),
    };
  });
}

export const allPassed = (results) => results.length > 0 && results.every((r) => r.code === 0);
