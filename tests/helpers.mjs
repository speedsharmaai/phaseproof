import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../scripts/phaseproof.mjs';

export function tempProject(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phaseproof-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function put(root, rel, text = '') {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

export function cli(root, ...argv) {
  const out = [];
  const err = [];
  const code = main(argv, { root, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

export const PASS = 'VERDICT: PASS\n\n## Findings\n- [minor] README.md:3 typo\n';
export const FAIL = 'VERDICT: FAIL\n\n## Findings\n- [blocker] src/a.js:10 no test\n';

export function approvedProject(t, checks = ['node -e "process.exit(0)"']) {
  const root = tempProject(t);
  cli(root, 'init', ...checks.flatMap((c) => ['--check', c]));
  put(root, 'phases/phase-01-auth/scope.md', '# Phase 01\n');
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  const r = cli(root, 'approve', '01');
  if (r.code !== 0) throw new Error(r.err);
  return root;
}
