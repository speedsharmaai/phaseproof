import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { decide } from '../scripts/lib/decide.mjs';
import { recordReview } from '../scripts/lib/drift.mjs';
import { join } from 'node:path';
import { approvalFile, gateFile, readJson, scopeField, scopeList } from '../scripts/lib/project.mjs';
import { isSkipLine, isTestFile, TEST_GLOBS, testTampering } from '../scripts/lib/tests-guard.mjs';
import { context, respond } from '../scripts/session.mjs';
import { cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const FAIL_REVIEW = 'VERDICT: FAIL\n- [blocker] scope.md:1 too big\n';
const SCOPE = '# Phase 01\n\n**Goal:** fix the typo in the header\n\n**Done when:** the header reads "Welcome"\n';

function project(t, dir = '') {
  const top = tempProject(t);
  git(top, 'init', '-q');
  const root = dir ? join(top, dir) : top;
  put(root, 'README.md', '# x\n');
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-typo/scope.md', SCOPE);
  put(root, 'src/a.test.js', 'test("a", () => { expect(1).toBe(1); });\n');
  put(root, 'src/b.test.js', 'test("b", () => { expect(2).toBe(2); });\nconst more = "lines to compare";\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'init');
  return root;
}
const passCode = (root) => recordReview(root, put(root, '.phaseproof/reviews/phase-01-code.md', PASS));

test('only the owner makes a phase quick, with approve --quick', (t) => {
  const root = project(t);
  assert.match(cli(root, 'approve').err, /docs review for phase 01/);
  const r = cli(root, 'approve', '--quick');
  assert.match(r.out, /Approved as quick: no docs review\./);
  assert.equal(readJson(approvalFile(root, '01')).size, 'quick');
  assert.match(cli(root, 'status').out, /approved as quick/);
  assert.match(cli(root, 'gate').err, /code review for phase 01/);
  passCode(root);
  assert.equal(cli(root, 'gate').code, 0);
  assert.equal(readJson(gateFile(root, '01')).reviews.docs, null);
});

test('a size line in scope.md changes nothing', (t) => {
  const root = project(t);
  put(root, 'phases/phase-01-typo/scope.md', `**Size:** quick\n${SCOPE}`);
  assert.match(cli(root, 'approve').err, /docs review for phase 01/);
});

test('approving as quick over a failed docs review says so', (t) => {
  const root = project(t);
  put(root, '.phaseproof/reviews/phase-01-docs.md', FAIL_REVIEW);
  assert.match(cli(root, 'approve', '--quick').out, /Approved as quick even though its docs review failed\./);
  assert.match(cli(root, 'status').out, /skipped, the owner approved it as quick \(verdict is FAIL\)/);
});

test('without --quick, a scope change after a quick approval needs a docs review; old approvals count as full', (t) => {
  const root = project(t);
  cli(root, 'approve', '--quick');
  put(root, 'phases/phase-01-typo/scope.md', `${SCOPE}\nalso rewrite auth\n`);
  assert.match(cli(root, 'status').out, /stale/);
  assert.match(cli(root, 'approve').err, /docs review for phase 01/);
  assert.equal(cli(root, 'approve', '--quick').code, 0);

  const old = project(t);
  put(old, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(old, 'approve');
  const a = readJson(approvalFile(old, '01'));
  delete a.size;
  delete a.base;
  put(old, '.phaseproof/approvals/phase-01.json', JSON.stringify(a));
  passCode(old);
  rmSync(join(old, '.phaseproof/reviews/phase-01-docs.md'));
  assert.match(cli(old, 'gate').err, /docs review for phase 01/);
});

test('approve rejects unknown options and second folders; files do not count as folders', (t) => {
  const root = project(t);
  assert.match(cli(root, 'approve', '--newbase').err, /unknown option --newbase/);
  put(root, 'phases/phase-01-notes.md', 'notes');
  assert.equal(cli(root, 'approve', '--quick').code, 0);
  put(root, 'phases/phase-01-a-fix/scope.md', SCOPE);
  assert.match(cli(root, 'approve', '--quick').err, /phase 01 has 2 folders \(phase-01-a-fix, phase-01-typo\)/);
});

test('deleted tests and new skips warn at the gate but never block it', (t) => {
  const root = project(t);
  cli(root, 'approve', '--quick');
  rmSync(join(root, 'src/b.test.js'));
  put(root, 'src/a.test.js', 'test.skip("a", () => { expect(1).toBe(1); });\n');
  passCode(root);
  const r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /check before trusting this gate \(warnings, the gate does not block on them\):/);
  assert.match(r.out, /possible deleted test: src\/b\.test\.js \(restore it, stage a move with git add -A, or have the owner list it under \*\*Removes tests:\*\*\)/);
  assert.match(r.out, /possible skip or focus added in src\/a\.test\.js/);
  assert.equal(readJson(gateFile(root, '01')).testWarnings.length, 2);
});

test('tests the owner lists under Removes tests are left out of the warnings', (t) => {
  const root = project(t);
  put(root, 'phases/phase-01-typo/scope.md', `${SCOPE}\n**Removes tests:** src/b.test.js\n`);
  assert.match(cli(root, 'approve', '--quick').out, /The scope allows removing tests: src\/b\.test\.js\./);
  passCode(root);
  rmSync(join(root, 'src/b.test.js'));
  assert.doesNotMatch(cli(root, 'gate').out, /possible deleted test/);
});
test('re-approving keeps the first base; --new-base resets it; a lost base warns', (t) => {
  const root = project(t);
  cli(root, 'approve', '--quick');
  rmSync(join(root, 'src/b.test.js'));
  git(root, 'commit', '-qam', 'drop test');
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL_REVIEW);
  cli(root, 'block');
  cli(root, 'approve', '--quick');
  passCode(root);
  assert.match(cli(root, 'gate').out, /possible deleted test: src\/b\.test\.js/);
  rmSync(join(root, '.phaseproof/gates/phase-01.json'));
  assert.equal(cli(root, 'approve', '--quick', '--new-base').code, 0);
  assert.doesNotMatch(cli(root, 'gate').out, /possible deleted test/);

  const lost = project(t);
  cli(lost, 'approve', '--quick');
  put(lost, '.phaseproof/approvals/phase-01.json', JSON.stringify({ ...readJson(approvalFile(lost, '01')), base: 'f'.repeat(40) }));
  passCode(lost);
  const r = cli(lost, 'gate');
  assert.equal(r.code, 0);
  assert.match(r.out, /tests were not compared: the approval's base commit ffffffffffff is gone/);
});
test('renames are not deletions, staged or not, and old skips in a renamed file are not new', (t) => {
  const root = project(t);
  put(root, 'src/c.test.js', 'test.skip("old", () => {});\nconst keep = "same content here";\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'c');
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  renameSync(join(root, 'src/b.test.js'), join(root, 'src/bb.test.js'));
  git(root, 'mv', 'src/c.test.js', 'src/cc.test.js');
  assert.equal(testTampering(root, head), null);
});

test('works for a project in a subfolder and under unusual git diff settings', (t) => {
  const root = project(t, 'apps/web');
  const top = join(root, '..', '..');
  const head = git(top, 'rev-parse', 'HEAD').stdout.trim();
  for (const [k, v] of [['diff.mnemonicPrefix', 'true'], ['diff.noprefix', 'true'], ['diff.external', 'false']]) git(top, 'config', k, v);
  put(root, 'src/a.test.js', 'test.only("a", () => {});\n');
  rmSync(join(root, 'src/b.test.js'));
  const r = testTampering(root, head);
  assert.deepEqual(r.removed, ['src/b.test.js']);
  assert.deepEqual(r.skipped.map((s) => s.file), ['src/a.test.js']);
  assert.equal(testTampering(root, head, 'src/b.test.js').removed.length, 0);
});

test('odd paths, untracked focus, exact allow-lists, non-git dirs', (t) => {
  const root = project(t);
  put(root, 'my tests/a b.test.js', 'x\n');
  put(root, 'tésts/a.test.js', 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'odd');
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  put(root, 'my tests/a b.test.js', 'test.skip("x", () => {});\n');
  put(root, 'tésts/a.test.js', 'test.only("x", () => {});\n');
  put(root, 'src/new.test.js', 'test("focus", { only: true }, () => {});\n');
  assert.deepEqual(testTampering(root, head).skipped.map((s) => s.file).sort(), ['my tests/a b.test.js', 'src/new.test.js', 'tésts/a.test.js']);
  rmSync(join(root, 'src/a.test.js'));
  assert.deepEqual(testTampering(root, head, 'src/a.test.jsx').removed, ['src/a.test.js']);
  assert.deepEqual(testTampering(root, head, 'src/').removed, []);
  assert.match(testTampering(tempProject(t), head).unchecked, /git is not available here/);
  assert.match(testTampering(root, 12345).unchecked, /no valid base commit/);
});

test('isTestFile: real layouts in, look-alikes and fixtures out', () => {
  for (const p of ['src/Latest.java', 'src/Contest.java', 'Fastest.kt', 'src/Attest.cs', 'docs/specs/old.md', 'specs/openapi.yaml', 'src/lib.rs', 'tests/fixtures/data.js', '__mocks__/api.js'])
    assert.ok(!isTestFile(p), p);
  for (const p of ['app/tests.py', 'lib/user_test.rb', 'mod_test.ts', 'tests/integration.rs', 'src/test/java/FooTest.java', 'FooTests.cs', 'spec/models/user_spec.rb', 'tests/conftest.py', 'e2e/login.cy.ts', 'UserSpec.kt', 'src/main/OrderIT.java'])
    assert.ok(isTestFile(p), p);
});

test('skip detection: real skips in each language, ordinary code left alone', () => {
  const hits = [
    ['a.test.js', 'it.skip.each([1])("x", () => {})'],
    ['a.test.ts', 'test.only.each([1])("x", () => {})'],
    ['a.test.ts', 'describe.skipIf(ci)("x", () => {})'],
    ['a.test.ts', 'it.concurrent.skip("x", () => {})'],
    ['e2e/a.spec.ts', 'test.fixme("x", async () => {})'],
    ['a.test.js', 'test("x", { skip: true }, () => {})'],
    ['a.test.js', 'test("x", { only: true }, () => {})'],
    ['a.test.js', '  t.skip("later")'],
    ['a.test.js', '  this.skip()'],
    ['tests/test_a.py', 'pytestmark = pytest.mark.skip'],
    ['tests/test_a.py', '        self.skipTest("later")'],
    ['tests/test_a.py', '@skip("later")'],
    ['tests/test_a.py', '        raise unittest.SkipTest("later")'],
    ['tests/test_a.py', '@unittest.expectedFailure'],
    ['a_test.go', '\tb.Skip("slow")'],
    ['spec/a_spec.rb', '  xit "works" do'],
    ['spec/a_spec.rb', '  fit "works" do'],
    ['spec/a_spec.rb', '  it "works", :focus do'],
    ['spec/a_spec.rb', '  it "works", skip: true do'],
    ['spec/a_spec.rb', '  it "works", pending: "later" do'],
    ['spec/a_spec.rb', '    skip "later"'],
    ['src/lib.rs', '#[ignore = "slow"]'],
    ['src/test/java/ATest.java', '@Test(enabled = false)'],
    ['src/test/java/ATest.java', '@DisabledOnOs(OS.WINDOWS)'],
    ['ATests.cs', '[Fact(Skip = "flaky")]'],
    ['ATests.swift', '@Test(.disabled("later")) func a() {}'],
  ];
  for (const [f, l] of hits) assert.ok(isSkipLine(f, l), `${f}: ${l}`);
  const misses = [
    ['tests/test_model.py', 'model.fit(X, y)'],
    ['tests/test_views.py', 'User.objects.only("id")'],
    ['tests/iter.rs', 'let v: Vec<_> = xs.iter().skip(1).collect();'],
    ['src/test/java/ATest.java', 'list.stream().skip(2)'],
    ['a.test.js', 'db.find().skip(10)'],
    ['spec/a_spec.rb', '  it "returns pending orders" do'],
    ['spec/a_spec.rb', '  it "should skip the header row" do'],
    ['spec/a_spec.rb', '  # skip the header'],
    ['spec/a_spec.rb', '  it "is a good fit" do'],
    ['spec/a_spec.rb', '    expect(order.status).to eq(:pending)'],
    ['a_test.go', '\tif err := d.Skip(); err != nil {'],
  ];
  for (const [f, l] of misses) assert.ok(!isSkipLine(f, l), `${f}: ${l}`);
});

test('scopeField ignores hidden lines', () => {
  assert.equal(scopeField('**Removes tests:** src/a.test.js', 'Removes tests'), 'src/a.test.js');
  assert.equal(scopeField('<!--\n**Removes tests:** src/a.test.js\n-->', 'Removes tests'), null);
});

test('session context: phase, goal, open or closed, capped, silent when not ours', (t) => {
  const root = project(t);
  const c = context(root);
  assert.match(c, /phaseproof is active\. Current phase: 01 \(phase-01-typo\)\. State: not approved yet, planning\./);
  assert.match(c, /Goal: fix the typo in the header/);
  assert.match(c, /Done when: the header reads "Welcome"/);
  assert.match(c, /Code is closed: phase 01 is not approved/);
  put(root, 'docs/learnings.md', '# Learnings\n');
  cli(root, 'approve', '--quick');
  const after = context(root);
  assert.match(after, /01 \(phase-01-typo\), approved as quick\. State: approved, building/);
  assert.match(after, /Read docs\/learnings\.md/);
  put(root, 'phases/phase-01-typo/scope.md', `**Goal:** ${'x'.repeat(5000)}\n\n**Done when:** ${'y'.repeat(5000)}\n`);
  const big = context(root);
  assert.ok(big.length <= 1500);
  assert.match(big, /Code is closed: phase 01 scope changed after it was approved\. The owner runs \/phaseproof:approve 01 --quick again/);
  assert.equal(JSON.parse(respond(JSON.stringify({ cwd: root, source: 'compact' }), '')).hookSpecificOutput.hookEventName, 'SessionStart');
  put(root, '.phaseproof/state.json', JSON.stringify({ version: 1, phase: { x: 1 } }));
  assert.equal(context(root), null);
  assert.equal(respond(JSON.stringify({ cwd: tempProject(t) }), ''), '');
  assert.equal(respond('nope', ''), '');
});

const PY = (name) => `import pytest\nfrom app.models import User\nfrom app.db import session\n\ndef test_${name}():\n    user = User(name="${name}")\n    assert user.name == "${name}"\n`;

test('a new file with the same imports does not excuse deleted tests', (t) => {
  const root = project(t);
  for (const n of ['users', 'items', 'orders', 'payments', 'refunds']) put(root, `tests/test_${n}.py`, PY(n));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'py');
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  for (const n of ['users', 'items', 'orders', 'payments', 'refunds']) rmSync(join(root, `tests/test_${n}.py`));
  put(root, 'tests/test_smoke.py', 'import pytest\nfrom app.models import User\nfrom app.db import session\n\ndef test_smoke():\n    assert True\n');
  assert.equal(testTampering(root, head).removed.length, 5);
  git(root, 'add', '-A');
  assert.equal(testTampering(root, head).removed.length, 5);
});

test('skip-worktree cannot hide a deleted test', (t) => {
  const root = project(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'update-index', '--skip-worktree', 'src/b.test.js');
  rmSync(join(root, 'src/b.test.js'));
  assert.deepEqual(testTampering(root, head).removed, ['src/b.test.js']);
});

test('an unstaged rename of a file with an old skip reports nothing', (t) => {
  const root = project(t);
  put(root, 'src/c.test.js', 'test.skip("old", () => {});\nconst keep = "same content here";\nconst more = 2;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'c');
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  renameSync(join(root, 'src/c.test.js'), join(root, 'src/cc.test.js'));
  assert.equal(testTampering(root, head), null);
});

test('several Removes tests lines and bullet lists all count', (t) => {
  const root = project(t);
  cli(root, 'approve', '--quick');
  rmSync(join(root, 'src/a.test.js'));
  rmSync(join(root, 'src/b.test.js'));
  put(root, 'phases/phase-01-typo/scope.md', `${SCOPE}\n**Removes tests:** none\n\n**Removes tests:**\n- src/a.test.js\n- \`src/b.test.js\`\n`);
  cli(root, 'approve', '--quick');
  passCode(root);
  const r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
});

test('a dangling symlink in phases/ neither crashes nor reopens code', { skip: process.platform === 'win32' }, (t) => {
  const root = project(t);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(root, 'approve');
  put(root, 'phases/phase-01-typo/scope.md', `${SCOPE}\nmore\n`);
  symlinkSync('/nonexistent', join(root, 'phases/phase-01-zlink'));
  assert.match(cli(root, 'status').out, /stale/);
  const d = decide({ root, toolName: 'Write', toolInput: { file_path: join(root, 'src/x.js') } });
  assert.equal(d.allow, false);
  assert.match(context(root), /Code is closed/);
});

const countObjects = (root) => git(root, 'count-objects', '-v').stdout;

test('git trouble elsewhere in the tree cannot hide a deleted test', { skip: process.platform === 'win32' }, (t) => {
  const root = project(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  rmSync(join(root, 'src/b.test.js'));
  put(root, 'src/locked.test.js', 'secret');
  chmodSync(join(root, 'src/locked.test.js'), 0o000);
  put(root, 'tool/README', 'x');
  git(join(root, 'tool'), 'init', '-q');
  git(root, 'config', 'diff.orderFile', '/nope');
  git(root, 'config', 'diff.renameLimit', '1');
  const result = testTampering(root, head);
  chmodSync(join(root, 'src/locked.test.js'), 0o600);
  assert.deepEqual(result.removed, ['src/b.test.js']);
});

test('big non-test files are never copied into the object store', (t) => {
  const root = project(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  put(root, 'data/big.bin', Buffer.alloc(3 * 1024 * 1024, 7));
  const before = countObjects(root);
  testTampering(root, head);
  assert.equal(countObjects(root), before);
});

test('a looping symlink in phases/ neither crashes nor reopens code', { skip: process.platform === 'win32' }, (t) => {
  const root = project(t);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(root, 'approve');
  put(root, 'phases/phase-01-typo/scope.md', `${SCOPE}\nmore\n`);
  symlinkSync('phase-01-zz', join(root, 'phases/phase-01-zz'));
  assert.match(cli(root, 'status').out, /stale/);
  assert.equal(decide({ root, toolName: 'Write', toolInput: { file_path: join(root, 'src/x.js') } }).allow, false);
});

test('Removes tests accepts the usual markdown shapes', () => {
  const list = (text) => scopeList(text, 'Removes tests');
  assert.deepEqual(list('**Removes tests:**\n\n- tests/a.py\n- tests/b.py\n'), ['tests/a.py', 'tests/b.py']);
  assert.deepEqual(list('**Removes tests:** tests/a.py\r\n'), ['tests/a.py']);
  assert.deepEqual(list('**Removes tests:**\r\n- tests/a.py\r\n'), ['tests/a.py']);
  assert.deepEqual(list('**Removes tests:**\n1. tests/a.py\n+ tests/b.py\n'), ['tests/a.py', 'tests/b.py']);
  assert.deepEqual(list('**Removes tests:** ./tests/a.py (old suite), `tests/b.py`\n'), ['tests/a.py', 'tests/b.py']);
  assert.deepEqual(list('**Removes tests:** none\n'), []);
});

test('a committed rename or allowed removal cannot hide another deletion, and the known bypasses are caught', (t) => {
  const root = project(t);
  put(root, 'src/c.test.js', 'test("c", () => { expect(3).toBe(3); });\nconst c = "third file body";\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'c');
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'mv', 'src/c.test.js', 'src/renamed.test.js');
  git(root, 'commit', '-qm', 'move c');
  rmSync(join(root, 'src/a.test.js'));
  assert.deepEqual(testTampering(root, head).removed, ['src/a.test.js']);
  assert.deepEqual(testTampering(root, head, 'src/a.test.js'), null);

  const mv = project(t);
  const h2 = git(mv, 'rev-parse', 'HEAD').stdout.trim();
  git(mv, 'mv', 'src/a.test.js', 'src/aa.test.js');
  rmSync(join(mv, 'src/aa.test.js'));
  assert.deepEqual(testTampering(mv, h2).removed, ['src/a.test.js']);

  const ig = project(t);
  const h3 = git(ig, 'rev-parse', 'HEAD').stdout.trim();
  git(ig, 'rm', '-q', '--cached', 'src/a.test.js');
  put(ig, '.gitignore', 'src/a.test.js\n');
  git(ig, 'add', '.gitignore');
  git(ig, 'commit', '-qm', 'hide');
  assert.deepEqual(testTampering(ig, h3).removed, ['src/a.test.js']);
});
test('safecrlf, autocrlf and symlink swaps do not hide deletions', { skip: process.platform === 'win32' }, (t) => {
  const root = project(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  git(root, 'config', 'core.autocrlf', 'true');
  git(root, 'config', 'core.safecrlf', 'true');
  put(root, 'src/new.test.js', 'a\r\nb\nc\r\n');
  rmSync(join(root, 'src/b.test.js'));
  rmSync(join(root, 'src/a.test.js'));
  symlinkSync('new.test.js', join(root, 'src/a.test.js'));
  assert.deepEqual(testTampering(root, head).removed, ['src/a.test.js', 'src/b.test.js']);
});

test('a big codemod across many test files neither crashes nor falsely refuses', (t) => {
  const root = project(t);
  for (let i = 0; i < 1500; i++) put(root, `tests/very/long/directory/name/for/argv/limits/case_${i}.test.js`, `test("${i}", () => {});\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'many');
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  for (let i = 0; i < 1500; i++) put(root, `tests/very/long/directory/name/for/argv/limits/case_${i}.test.js`, `test("${i}!", () => {});\n`);
  assert.equal(testTampering(root, head), null);
});

test('none on the Removes tests line keeps later bullets out', () => {
  assert.deepEqual(scopeList('**Removes tests:** none\n\n- left for later\n', 'Removes tests'), []);
});

test('every path isTestFile accepts is inside the git globs the guard diffs', (t) => {
  const root = tempProject(t);
  git(root, 'init', '-q');
  const dirs = ['', 'src/', 'pkg/a/', 'tests/', 'test/', '__tests__/', 'spec/', 'src/test/java/com/x/', 'e2e/'];
  const names = ['a.test.js', 'a.spec.tsx', 'a.cy.ts', 'a_test.go', 'a_test.py', 'a_spec.rb', 'a_test.rb', 'mod_test.ts', 'test_api.py', 'tests.py', 'conftest.py', 'FooTest.java', 'FooTests.cs', 'UserSpec.kt', 'OrderIT.java', 'helper.js', 'lib.rs', 'util.py', 'a.rb'];
  const paths = dirs.flatMap((d) => names.map((n) => d + n));
  const lines = paths.map((p) => `100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\t${p}`).join('\n') + '\n';
  spawnSync('git', ['update-index', '--add', '--index-info'], { cwd: root, input: lines });
  const listed = new Set(spawnSync('git', ['--glob-pathspecs', 'ls-files', '-z', '--', ...TEST_GLOBS], { cwd: root, encoding: 'utf8' }).stdout.split('\0'));
  const missing = paths.filter((p) => isTestFile(p) && !listed.has(p));
  assert.deepEqual(missing, []);
});

test('falsy and malformed bases warn instead of passing silently; a null approval does not crash', (t) => {
  const root = project(t);
  for (const base of ['', 0, false, 12345]) assert.match(testTampering(root, base).unchecked, /no valid base commit/);
  cli(root, 'approve', '--quick');
  passCode(root);
  put(root, '.phaseproof/approvals/phase-01.json', 'null');
  assert.doesNotThrow(() => cli(root, 'status'));
  assert.doesNotThrow(() => cli(root, 'gate'));
});

test('an added line that looks like a diff header does not hide a skip', (t) => {
  const root = project(t);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  put(root, 'src/a.test.js', 'test("a", () => {});\n++ b/x.md\ntest.skip("b", () => {});\n');
  assert.deepEqual(testTampering(root, head).skipped.map((s) => s.file), ['src/a.test.js']);
});

test('more than 50 test warnings are capped', (t) => {
  const root = project(t);
  for (let i = 0; i < 60; i++) put(root, `tests/t${i}.test.js`, `test("${i}", () => { expect(${i}).toBe(${i}); });\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'many');
  cli(root, 'approve', '--quick', '--new-base');
  for (let i = 0; i < 60; i++) rmSync(join(root, `tests/t${i}.test.js`));
  passCode(root);
  const out = cli(root, 'gate').out;
  assert.match(out, /and 10 more/);
  assert.equal(readJson(gateFile(root, '01')).testWarnings.length, 51);
});
