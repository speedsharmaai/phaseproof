import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { approvalFile, blockFile, gateFile, loadConfig, loadState, readJson, runFile } from '../scripts/lib/project.mjs';
import { approvedProject, cli, FAIL, PASS, put, tempProject } from './helpers.mjs';

test('usage without a command, error on an unknown one', (t) => {
  const root = tempProject(t);
  assert.equal(cli(root).code, 0);
  assert.equal(cli(root, 'launch').code, 2);
});

test('init writes state and checks once', (t) => {
  const root = tempProject(t);
  assert.equal(cli(root, 'init', '--check', 'pnpm test', '--check', 'pnpm typecheck').code, 0);
  assert.deepEqual(loadState(root), { version: 1, phase: '01' });
  assert.deepEqual(loadConfig(root).checks, ['pnpm test', 'pnpm typecheck']);
  assert.match(cli(root, 'init').out, /already tracked/);
});

test('commands refuse in an untracked project', (t) => {
  const root = tempProject(t);
  const r = cli(root, 'status');
  assert.equal(r.code, 1);
  assert.match(r.err, /phaseproof init/);
});

test('approve needs scope.md and a passing docs review', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.match(cli(root, 'approve', '1').err, /scope\.md first/);
  put(root, 'phases/phase-01-auth/scope.md', '# x');
  assert.match(cli(root, 'approve', '1').err, /docs review for phase 01: no review report/);
  put(root, '.phaseproof/reviews/phase-01-docs.md', FAIL);
  assert.match(cli(root, 'approve', '1').err, /verdict is FAIL/);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  assert.equal(cli(root, 'approve', '1').code, 0);
  assert.ok(existsSync(approvalFile(root, '01')));
});

test('approve needs a design review when the phase has screens', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  put(root, 'phases/phase-01-auth/scope.md', '# x');
  put(root, 'phases/phase-01-auth/screens.md', '# screens');
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  assert.match(cli(root, 'approve').err, /design review/);
  put(root, '.phaseproof/reviews/phase-01-design.md', PASS);
  assert.equal(cli(root, 'approve').code, 0);
});

test('approve only the current phase', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.match(cli(root, 'approve', '3').err, /current phase is 01/);
  assert.match(cli(root, 'approve', 'abc').err, /not a phase number/);
});

test('check records results and fails on a failing command', (t) => {
  const root = approvedProject(t, ['node -e "process.exit(0)"', 'node -e "process.exit(3)"']);
  const r = cli(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL node -e "process.exit\(3\)"/);
  assert.deepEqual(readJson(runFile(root, '01')).results.map((x) => x.code), [0, 3]);
});

test('check without configured checks refuses', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.match(cli(root, 'check').err, /no checks configured/);
});

test('gate needs approval, a passing code review and green checks', (t) => {
  const root = tempProject(t);
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  assert.match(cli(root, 'gate', '01').err, /never approved/);

  const ok = approvedProject(t);
  assert.match(cli(ok, 'gate').err, /code review for phase 01/);
  put(ok, '.phaseproof/reviews/phase-01-code.md', PASS);
  const r = cli(ok, 'gate');
  assert.equal(r.code, 0, r.err);
  const gate = readJson(gateFile(ok, '01'));
  assert.equal(gate.checks[0].code, 0);
  assert.equal(gate.reviews.code.length, 64);
});

test('gate re-runs checks itself instead of trusting an old run', (t) => {
  const root = approvedProject(t, ['node -e "process.exit(1)"']);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  put(root, '.phaseproof/runs/phase-01-checks.json', JSON.stringify({ results: [{ cmd: 'x', code: 0 }] }));
  const r = cli(root, 'gate');
  assert.equal(r.code, 1);
  assert.match(r.err, /gate stays open/);
  assert.equal(existsSync(gateFile(root, '01')), false);
});

test('next moves on only after the gate', (t) => {
  const root = approvedProject(t);
  assert.match(cli(root, 'next').err, /has not passed its gate/);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  cli(root, 'gate');
  assert.equal(cli(root, 'next').code, 0);
  assert.equal(loadState(root).phase, '02');
});

test('status reports each step', (t) => {
  const root = approvedProject(t);
  const s = cli(root, 'status').out;
  assert.match(s, /phase 01 \(phase-01-auth\)/);
  assert.match(s, /docs review {2}pass/);
  assert.match(s, /approved {5}yes/);
  assert.match(s, /gate {9}open/);
});

test('block needs a failed code review', (t) => {
  const root = approvedProject(t);
  assert.match(cli(root, 'block').err, /block is for a failed code review/);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.match(cli(root, 'block').err, /block is for a failed code review/);
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  const r = cli(root, 'block');
  assert.equal(r.code, 0);
  assert.match(r.out, /phase 01 blocked: verdict is FAIL/);
  assert.equal(readJson(blockFile(root, '01')).blockers.length, 1);
});

test('blocked phase: status says so, gate refuses, approve clears it', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  cli(root, 'block');
  assert.match(cli(root, 'status').out, /BLOCKED {6}verdict is FAIL, waiting on the owner/);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.match(cli(root, 'gate').err, /is blocked/);
  const r = cli(root, 'approve');
  assert.match(r.out, /Block cleared/);
  assert.equal(existsSync(blockFile(root, '01')), false);
  assert.equal(cli(root, 'gate').code, 0);
});

test('changed scope needs a fresh docs review before re-approval', (t) => {
  const root = approvedProject(t);
  put(root, 'phases/phase-01-auth/tasks.md', '## 1 · new task\n');
  assert.match(cli(root, 'status').out, /approved {5}stale, scope changed since approval/);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.match(cli(root, 'gate').err, /scope changed since approval/);
  assert.match(cli(root, 'approve').err, /Get a fresh docs review first/);
  put(root, '.phaseproof/reviews/phase-01-docs.md', `${PASS}\nre-reviewed after the tasks change\n`);
  assert.equal(cli(root, 'approve').code, 0);
  assert.match(cli(root, 'status').out, /approved {5}yes/);
});

test('re-approving an unchanged scope needs no new review', (t) => {
  const root = approvedProject(t);
  assert.equal(cli(root, 'approve').code, 0);
});

test('approval records the scope and docs review hashes', (t) => {
  const root = approvedProject(t);
  const a = readJson(approvalFile(root, '01'));
  assert.equal(a.scopeHash.length, 64);
  assert.equal(a.docsReview.length, 64);
});
