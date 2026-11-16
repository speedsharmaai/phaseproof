import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const RUNNER = fileURLToPath(new URL('./run-check.mjs', import.meta.url));

export function runChecks(root, commands, timeoutMs = CHECK_TIMEOUT_MS) {
  return commands.map((cmd) => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [RUNNER, cmd, String(timeoutMs)], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 30000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    const lines = out.split(/\r?\n/).slice(-20);
    if (r.error) lines.push(`phaseproof: ${r.error.message}`);
    return {
      cmd,
      code: typeof r.status === 'number' ? r.status : 1,
      ms: Date.now() - started,
      tail: lines.join('\n').trim(),
    };
  });
}

export const allPassed = (results) => results.length > 0 && results.every((r) => r.code === 0);
