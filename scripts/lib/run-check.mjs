import { spawn, spawnSync } from 'node:child_process';

const [cmd, limit] = process.argv.slice(2);
const ms = Number(limit);
const windows = process.platform === 'win32';
const child = spawn(cmd, { shell: true, detached: !windows, stdio: ['ignore', 'inherit', 'inherit'] });

function stopAll() {
  try {
    if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
}

const timer = setTimeout(() => {
  process.stderr.write(`\nphaseproof: timed out after ${Math.round(ms / 1000)} s and was stopped, with everything it started\n`);
  stopAll();
  process.exit(124);
}, ms);

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

const parent = process.ppid;
const watch = setInterval(() => {
  if (process.ppid !== parent) {
    stopAll();
    process.exit(1);
  }
}, 1000);

child.on('error', (e) => {
  clearTimeout(timer);
  clearInterval(watch);
  process.stderr.write(`phaseproof: ${e.message}\n`);
  process.exit(1);
});
child.on('exit', (code) => {
  clearTimeout(timer);
  clearInterval(watch);
  process.exit(code ?? 1);
});
