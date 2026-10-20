import { spawnSync } from 'node:child_process';

export function runChecks(root, commands, spawn = spawnSync) {
  return commands.map((cmd) => {
    const started = Date.now();
    const r = spawn(cmd, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    return {
      cmd,
      code: typeof r.status === 'number' ? r.status : 1,
      ms: Date.now() - started,
      tail: out.split(/\r?\n/).slice(-20).join('\n'),
    };
  });
}

export const allPassed = (results) => results.length > 0 && results.every((r) => r.code === 0);
