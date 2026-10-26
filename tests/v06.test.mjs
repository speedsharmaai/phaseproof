import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { decide } from '../scripts/lib/decide.mjs';
import { measure, overBudget } from '../scripts/lib/budget.mjs';
import { recordReview } from '../scripts/lib/drift.mjs';
import { gateFile, readJson, runFile, scopeBudget, scopeCommands } from '../scripts/lib/project.mjs';
import { cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const SCOPE = '# Phase 01\n\n**Goal:** g\n\n**Done when:** d\n';

function project(t, scope) {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'src/app.js', 'export const app = 1;\n');
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-x/scope.md', scope);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}
const review = (root) => recordReview(root, put(root, '.phaseproof/reviews/phase-01-code.md', PASS));

test('Gate runs keeps whole commands, inline or as a list', () => {
  assert.deepEqual(scopeCommands('**Gate runs:** `node --test a.test.js`', 'Gate runs'), ['node --test a.test.js']);
  assert.deepEqual(scopeCommands('**Gate runs:**\n\n- npm test -- a,b\n- `grep "ok (1)" out.txt`\n\nmore', 'Gate runs'), ['npm test -- a,b', 'grep "ok (1)" out.txt']);
  assert.deepEqual(scopeCommands('**Gate runs:** none\n<!--\n**Gate runs:** rm -rf /\n-->', 'Gate runs'), []);
});

test('the gate runs the phase commands too, and refuses when one fails', (t) => {
  const root = project(t, `${SCOPE}\n**Gate runs:** node -e "process.exit(require('fs').existsSync('done.txt') ? 0 : 1)"\n`);
  const a = cli(root, 'approve');
  assert.match(a.out, /For this phase it also runs: node -e/);
  review(root);
  const r = cli(root, 'gate');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL node -e "process\.exit\(require/);
  assert.equal(readJson(runFile(root, '01')).results.length, 2);
  put(root, 'done.txt', 'yes');
  review(root);
  assert.equal(cli(root, 'gate').code, 0);
});

test('editing Gate runs after approval closes code like any scope change', (t) => {
  const root = project(t, `${SCOPE}\n**Gate runs:** node --test\n`);
  cli(root, 'approve');
  put(root, 'phases/phase-01-x/scope.md', `${SCOPE}\n**Gate runs:** true\n`);
  assert.match(decide({ root, toolName: 'Write', toolInput: { file_path: join(root, 'src/app.js') } }).reason, /scope changed after it was approved/);
});

test('phase commands alone are enough to run checks', (t) => {
  const root = project(t, `${SCOPE}\n**Gate runs:** node -e "process.exit(0)"\n`);
  put(root, '.phaseproof/config.json', '{"checks": []}');
  assert.match(cli(root, 'approve').out, /No project checks are configured\. For this phase it also runs/);
  assert.equal(cli(root, 'check').code, 0);
});

test('Budget is read from scope.md in any order, and compared per limit', (t) => {
  const root = tempProject(t);
  put(root, 'phases/phase-01-x/scope.md', `${SCOPE}\n**Budget:** 8 files, 300 lines\n`);
  assert.deepEqual(scopeBudget(root, '01'), { lines: 300, files: 8 });
  put(root, 'phases/phase-01-x/scope.md', `${SCOPE}\n**Budget:** 40 lines\n`);
  assert.deepEqual(scopeBudget(root, '01'), { lines: 40, files: null });
  put(root, 'phases/phase-01-x/scope.md', `${SCOPE}\n**Budget:** none\n`);
  assert.equal(scopeBudget(root, '01'), null);
  assert.equal(overBudget({ lines: 10, files: null }, { lines: 11, files: 99 }), '11 lines (budget 10)');
  assert.equal(overBudget({ lines: 10, files: 2 }, { lines: 10, files: 2 }), null);
  assert.equal(overBudget(null, { lines: 1, files: 1 }), null);
});

test('the gate warns, without refusing, when code outgrows the budget; docs do not count', (t) => {
  const root = project(t, `${SCOPE}\n**Budget:** 3 lines, 1 file\n`);
  assert.deepEqual(scopeBudget(root, '01'), { lines: 3, files: 1 });
  assert.match(cli(root, 'approve').out, /Budget: 3 lines, 1 file of code\./);
  put(root, 'src/app.js', 'export const app = 2;\n');
  put(root, 'docs/long.md', 'a\nb\nc\nd\ne\n');
  const base = readJson(join(root, '.phaseproof/approvals/phase-01.json')).base;
  assert.deepEqual(measure(root, base), { lines: 2, files: 1 });
  assert.match(cli(root, 'status').out, /budget {7}2\/3 lines, 1\/1 files/);
  put(root, 'src/new.js', 'a\nb\nc\n');
  assert.deepEqual(measure(root, base), { lines: 5, files: 2 });
  assert.match(cli(root, 'status').out, /5\/3 lines, 2\/1 files, OVER/);
  review(root);
  const r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /this phase changed 5 lines \(budget 3\) and 2 files \(budget 1\)\. Split the rest/);
  assert.match(readJson(gateFile(root, '01')).warnings.join('\n'), /budget 3/);
});

test('no budget, no git or a bad base measures nothing', (t) => {
  const root = project(t, SCOPE);
  assert.equal(scopeBudget(root, '01'), null);
  assert.equal(measure(root, 'nope'), null);
  assert.equal(measure(tempProject(t), 'abc1234'), null);
  cli(root, 'approve');
  assert.doesNotMatch(cli(root, 'status').out, /budget/);
});
