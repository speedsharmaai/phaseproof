import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gateFile, readJson, approvalFile } from '../scripts/lib/project.mjs';
import { isTestFile, testTampering } from '../scripts/lib/tests-guard.mjs';
import { context, respond } from '../scripts/session.mjs';
import { cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });

const QUICK = '# Phase 01\n\n**Size:** quick\n\n**Goal:** fix the typo in the header\n\n**Done when:** the header reads "Welcome"\n';

function quickProject(t) {
  const root = tempProject(t);
  git(root, 'init', '-q');
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-typo/scope.md', QUICK);
  put(root, 'src/a.test.js', 'test("a", () => {});\n');
  put(root, 'src/b.test.js', 'test("b", () => {});\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('a quick phase is approved without a docs review, but still needs the code review to gate', (t) => {
  const root = quickProject(t);
  assert.match(cli(root, 'status').out, /phase 01 \(phase-01-typo\), quick/);
  assert.match(cli(root, 'status').out, /docs review {2}not needed for a quick phase/);
  assert.equal(cli(root, 'approve').code, 0);
  assert.match(cli(root, 'gate').err, /code review for phase 01/);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.equal(cli(root, 'gate').code, 0);
  assert.equal(readJson(gateFile(root, '01')).reviews.docs, null);
});

test('a full phase still needs its docs review', (t) => {
  const root = quickProject(t);
  put(root, 'phases/phase-01-typo/scope.md', QUICK.replace('**Size:** quick', '**Size:** full'));
  assert.match(cli(root, 'approve').err, /docs review for phase 01/);
});

test('editing a quick scope after approval can be re-approved without a review', (t) => {
  const root = quickProject(t);
  cli(root, 'approve');
  put(root, 'phases/phase-01-typo/scope.md', `${QUICK}\nalso the footer\n`);
  assert.equal(cli(root, 'approve').code, 0);
});

test('isTestFile knows the common layouts', () => {
  for (const p of ['src/a.test.ts', 'lib/x.spec.jsx', 'tests/unit/a.js', '__tests__/b.js', 'pkg/test_api.py', 'api_test.go', 'FooTest.java', 'user_spec.rb']) assert.ok(isTestFile(p), p);
  for (const p of ['src/latest.js', 'src/contest.ts', 'docs/testing.md', 'protest.py']) assert.ok(!isTestFile(p), p);
});

test('the gate refuses deleted tests and new skips, unless the scope names them', (t) => {
  const root = quickProject(t);
  cli(root, 'approve');
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  rmSync(join(root, 'src/b.test.js'));
  put(root, 'src/a.test.js', 'test.skip("a", () => {});\n');
  const r = cli(root, 'gate');
  assert.equal(r.code, 1);
  assert.match(r.err, /removed src\/b\.test\.js/);
  assert.match(r.err, /skip or focus added in src\/a\.test\.js: test\.skip\("a"/);
  assert.equal(existsSync(gateFile(root, '01')), false);

  const tampered = testTampering(root, readJson(approvalFile(root, '01')).head, 'Removes tests: src/b.test.js\nSkips tests: src/a.test.js');
  assert.equal(tampered, null);
});

test('focused tests count as skipping the rest', (t) => {
  const root = quickProject(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  put(root, 'src/a.test.js', 'it.only("a", () => {});\n');
  assert.equal(testTampering(root, head).skipped[0].file, 'src/a.test.js');
  put(root, 'src/a.test.js', 'test("a", () => { expect(1).toBe(1); });\n');
  assert.equal(testTampering(root, head), null);
  assert.equal(testTampering(root, null), null);
});

test('session context re-states the phase, goal and gate after a compact', (t) => {
  const root = quickProject(t);
  const c = context(root);
  assert.match(c, /phaseproof is active\. Current phase: 01 \(phase-01-typo\), quick\. State: not approved yet, planning\./);
  assert.match(c, /Goal: fix the typo in the header/);
  assert.match(c, /Done when: the header reads "Welcome"/);
  assert.match(c, /Code is closed: phase 01 is not approved/);
  put(root, 'docs/learnings.md', '# Learnings\n');
  cli(root, 'approve');
  const after = context(root);
  assert.match(after, /State: approved, building/);
  assert.match(after, /Code is open for this phase only/);
  assert.match(after, /Read docs\/learnings\.md/);
  const out = JSON.parse(respond(JSON.stringify({ cwd: root, source: 'compact' }), ''));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('session hook is silent outside phaseproof projects and on bad input', (t) => {
  assert.equal(respond(JSON.stringify({ cwd: tempProject(t) }), ''), '');
  assert.equal(respond('nope', ''), '');
});
