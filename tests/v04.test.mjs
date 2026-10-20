import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gateFile, readJson, approvalFile } from '../scripts/lib/project.mjs';
import { isSkipLine, isTestFile, testTampering } from '../scripts/lib/tests-guard.mjs';
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

  const tampered = testTampering(root, readJson(approvalFile(root, '01')).base, 'src/b.test.js, src/a.test.js');
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

const FULL = '# Phase 01\n\n**Size:** full\n\n**Goal:** billing\n\n**Done when:** invoices send\n';

test('a hidden or sloppy quick line does not make a phase quick', (t) => {
  const root = quickProject(t);
  for (const scope of [`${FULL}<!--\n**Size:** quick\n-->\n`, `${FULL}\`\`\`\n**Size:** quick\n\`\`\`\n`, FULL.replace('full', 'quick-ish'), FULL.replace('full', 'QUICK')]) {
    put(root, 'phases/phase-01-typo/scope.md', scope);
    assert.match(cli(root, 'approve').err, /docs review for phase 01/, scope);
  }
});

test('quick never skips a docs review that failed', (t) => {
  const root = quickProject(t);
  put(root, '.phaseproof/reviews/phase-01-docs.md', 'VERDICT: FAIL\n- [blocker] scope.md:1 too big\n');
  assert.match(cli(root, 'approve').err, /verdict is FAIL/);
});

test('a phase approved as full stays full when its scope flips to quick', (t) => {
  const root = quickProject(t);
  put(root, 'phases/phase-01-typo/scope.md', FULL);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  assert.equal(cli(root, 'approve').code, 0);
  put(root, 'phases/phase-01-typo/scope.md', `${FULL.replace('full', 'quick')}\nalso rewrite auth\n`);
  assert.match(cli(root, 'approve').err, /Get a fresh docs review first/);
});

test('approve says when a phase is quick and when the scope allows test changes', (t) => {
  const root = quickProject(t);
  put(root, 'phases/phase-01-typo/scope.md', `${QUICK}\n**Removes tests:** src/b.test.js\n`);
  const out = cli(root, 'approve').out;
  assert.match(out, /Quick phase: no docs review\./);
  assert.match(out, /The scope allows test changes: src\/b\.test\.js\./);
});

test('a second folder for the current phase is refused', (t) => {
  const root = quickProject(t);
  put(root, 'phases/phase-01-a-fix/scope.md', QUICK);
  assert.match(cli(root, 'approve').err, /phase 01 has 2 folders \(phase-01-a-fix, phase-01-typo\)/);
});

test('re-approving keeps the first base, so earlier test deletions are still caught', (t) => {
  const root = quickProject(t);
  cli(root, 'approve');
  rmSync(join(root, 'src/b.test.js'));
  git(root, 'commit', '-qam', 'drop test');
  put(root, '.phaseproof/reviews/phase-01-code.md', 'VERDICT: FAIL\n- [blocker] x:1 y\n');
  cli(root, 'block');
  cli(root, 'approve');
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.match(cli(root, 'gate').err, /removed src\/b\.test\.js/);
  assert.equal(cli(root, 'approve', '--new-base').code, 0);
  assert.equal(cli(root, 'gate').code, 0);
});

test('the gate refuses when the base commit is gone', (t) => {
  const root = quickProject(t);
  cli(root, 'approve');
  const a = readJson(approvalFile(root, '01'));
  put(root, '.phaseproof/approvals/phase-01.json', JSON.stringify({ ...a, base: 'f'.repeat(40) }));
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.match(cli(root, 'gate').err, /base commit ffffffffffff is gone/);
});

test('isTestFile: no false positives on names that merely end in test or live in specs folders', () => {
  for (const p of ['src/Latest.java', 'src/Contest.java', 'Fastest.kt', 'src/Attest.cs', 'docs/specs/old.md', 'specs/openapi.yaml', 'src/lib.rs', 'docs/spec/api.md']) assert.ok(!isTestFile(p), p);
  for (const p of ['app/tests.py', 'lib/user_test.rb', 'mod_test.ts', 'tests/integration.rs', 'src/test/java/FooTest.java', 'FooTests.cs', 'spec/models/user_spec.rb', 'tests/conftest.py']) assert.ok(isTestFile(p), p);
});

test('skip detection: real skips in each language, ordinary calls left alone', () => {
  const hits = [
    ['a.test.js', 'it.skip.each([1])("x", () => {})'],
    ['a.test.ts', 'test.only.each([1])("x", () => {})'],
    ['a.test.ts', 'describe.skipIf(ci)("x", () => {})'],
    ['e2e/a.spec.ts', 'test.fixme("x", async () => {})'],
    ['tests/test_a.py', 'pytestmark = pytest.mark.skip'],
    ['tests/test_a.py', '        self.skipTest("later")'],
    ['tests/test_a.py', '@skip("later")'],
    ['a_test.go', '\tb.Skip("slow")'],
    ['spec/a_spec.rb', '  xit "works" do'],
    ['spec/a_spec.rb', '  fit "works" do'],
    ['spec/a_spec.rb', '  it "works", :focus do'],
    ['src/lib.rs', '#[ignore = "slow"]'],
    ['src/test/java/ATest.java', '@Test(enabled = false)'],
    ['ATests.cs', '[Fact(Skip = "flaky")]'],
  ];
  for (const [f, l] of hits) assert.ok(isSkipLine(f, l), `${f}: ${l}`);
  const misses = [
    ['tests/test_model.py', 'model.fit(X, y)'],
    ['tests/test_views.py', 'User.objects.only("id")'],
    ['tests/iter.rs', 'let v: Vec<_> = xs.iter().skip(1).collect();'],
    ['src/test/java/ATest.java', 'list.stream().skip(2)'],
    ['a.test.js', 'db.find().skip(10)'],
    ['spec/a_spec.rb', 'expect(order.status).to eq("pending")'],
    ['spec/a_spec.rb', 'expect(order.status).to eq(:pending)'],
  ];
  for (const [f, l] of misses) assert.ok(!isSkipLine(f, l), `${f}: ${l}`);
});

test('test guard handles renames, odd paths, untracked focus and exact allow-lists', (t) => {
  const root = quickProject(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'mv', 'src/b.test.js', 'src/c.test.js');
  assert.equal(testTampering(root, head), null);
  put(root, 'my tests/a b.test.js', 'x\n');
  put(root, 'tésts/a.test.js', 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'odd');
  const head2 = git(root, 'rev-parse', 'HEAD').stdout.trim();
  put(root, 'my tests/a b.test.js', 'test.skip("x", () => {});\n');
  put(root, 'tésts/a.test.js', 'test.only("x", () => {});\n');
  put(root, 'src/new.test.js', 'test.only("focus", () => {});\n');
  const r = testTampering(root, head2);
  assert.deepEqual(r.skipped.map((s) => s.file).sort(), ['my tests/a b.test.js', 'src/new.test.js', 'tésts/a.test.js']);
  assert.equal(testTampering(root, head2, 'src/new.test.jsx').skipped.length, 3);
  assert.equal(testTampering(root, head2, 'my tests/, tésts/a.test.js, src/new.test.js'), null);
  assert.equal(testTampering(tempProject(t), head2), null);
});

test('session context keeps the open or closed line even with a huge goal', (t) => {
  const root = quickProject(t);
  put(root, 'phases/phase-01-typo/scope.md', `**Size:** quick\n\n**Goal:** ${'x'.repeat(5000)}\n\n**Done when:** ${'y'.repeat(5000)}\n`);
  const c = context(root);
  assert.ok(c.length <= 1500);
  assert.match(c, /Code is closed/);
  put(root, '.phaseproof/state.json', JSON.stringify({ version: 1, phase: { x: 1 } }));
  assert.equal(context(root), null);
});

test('the scope-changed message for a quick phase does not ask for a docs review', (t) => {
  const root = quickProject(t);
  cli(root, 'approve');
  put(root, 'phases/phase-01-typo/scope.md', `${QUICK}\nmore\n`);
  const r = cli(root, 'status');
  assert.match(r.out, /stale/);
});
