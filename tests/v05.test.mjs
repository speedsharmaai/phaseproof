import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '../scripts/lib/decide.mjs';
import { codeFingerprint, driftSince, isFingerprint, recordReview, reviewDrift, reviewRecordFile } from '../scripts/lib/drift.mjs';
import { approvalFile, configHash, gateFile, readJson, scopeHash, writeJson } from '../scripts/lib/project.mjs';
import { respond as post } from '../scripts/post.mjs';
import { context } from '../scripts/session.mjs';
import { cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const SCOPE = '# Phase 01\n\n**Goal:** sign in with a code\n\n**Done when:** a user signs in with the emailed code\n';
const LOCKED = `${SCOPE}\n**Locked tests:** tests/otp.test.js\n`;
const REVIEW = '.phaseproof/reviews/phase-01-code.md';

function project(t, scope = SCOPE) {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'README.md', '# x\n');
  put(root, 'src/app.js', 'export const app = 1;\n');
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-otp/scope.md', scope);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const write = (root, rel) => decide({ root, toolName: 'Write', toolInput: { file_path: join(root, rel) } });
const saveReview = (root, text = PASS) => post(JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: put(root, REVIEW, text) } }), root);

test('a locked test can be written before approval; other listed files cannot', (t) => {
  const root = project(t, `${SCOPE}\n**Locked tests:**\n- tests/otp.test.js\n- src/app.js\n`);
  assert.equal(write(root, 'tests/otp.test.js').allow, true);
  assert.equal(write(root, 'tests/other.test.js').allow, false);
  const d = write(root, 'src/app.js');
  assert.equal(d.allow, false);
  assert.match(d.reason, /listed under \*\*Locked tests:\*\* but is not a test file/);
});

test('approve refuses locked tests that are missing, outside the project or not tests, and names the ones it locks', (t) => {
  const root = project(t, LOCKED);
  assert.match(cli(root, 'approve').err, /locked test tests\/otp\.test\.js does not exist yet/);
  put(root, 'phases/phase-01-otp/scope.md', `${SCOPE}\n**Locked tests:** ../outside.test.js\n`);
  assert.match(cli(root, 'approve').err, /outside the project/);
  put(root, 'phases/phase-01-otp/scope.md', `${SCOPE}\n**Locked tests:** .phaseproof/runs/x.test.js\n`);
  assert.match(cli(root, 'approve').err, /outside the project/);
  put(root, 'phases/phase-01-otp/scope.md', `${SCOPE}\n**Locked tests:** src/app.js\n`);
  assert.match(cli(root, 'approve').err, /does not look like a test file/);
  put(root, 'phases/phase-01-otp/scope.md', `${SCOPE}\n**Locked tests:** tests/\n`);
  put(root, 'tests/a.test.js', 'x');
  assert.match(cli(root, 'approve').err, /does not exist yet, or is not a file/);
  put(root, 'phases/phase-01-otp/scope.md', LOCKED);
  put(root, 'tests/otp.test.js', 'test("otp", () => {});\n');
  const r = cli(root, 'approve');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Locked tests, closed to edits until the gate: tests\/otp\.test\.js\./);
  assert.match(cli(root, 'status').out, /locked tests tests\/otp\.test\.js/);
  assert.match(context(root), /Locked tests \(make them pass, never edit them\): tests\/otp\.test\.js/);
});

test('after approval a locked test is closed to file tools, and a shell edit closes code and the gate', (t) => {
  const root = project(t, LOCKED);
  put(root, 'tests/otp.test.js', 'test("otp", () => { expect(code).toBe("123456"); });\n');
  assert.equal(cli(root, 'approve').code, 0);
  const d = write(root, 'tests/otp.test.js');
  assert.equal(d.allow, false);
  assert.match(d.reason, /locked test of phase 01/);
  assert.equal(write(root, 'src/app.js').allow, true);
  writeFileSync(join(root, 'tests/otp.test.js'), 'test("otp", () => {});\n');
  assert.match(write(root, 'src/app.js').reason, /scope changed after it was approved/);
  saveReview(root);
  assert.match(cli(root, 'gate').err, /scope changed since approval \(scope\.md, tasks\.md, screens\.md or a locked test\)/);
  rmSync(join(root, 'tests/otp.test.js'));
  assert.match(cli(root, 'gate').err, /scope changed since approval/);
});

test('scopes without locked tests hash as before, so older approvals stay valid', (t) => {
  const root = project(t);
  const before = scopeHash(root, '01');
  put(root, 'phases/phase-01-otp/scope.md', `${SCOPE}\n**Locked tests:** none\n`);
  assert.notEqual(scopeHash(root, '01'), before);
  put(root, 'phases/phase-01-otp/scope.md', SCOPE);
  assert.equal(scopeHash(root, '01'), before);
});

test('changing the checks or doc paths after approval closes code and refuses the gate until the owner approves again', (t) => {
  const root = project(t);
  assert.equal(cli(root, 'approve').code, 0);
  assert.equal(readJson(approvalFile(root, '01')).configHash, configHash(root));
  saveReview(root);
  const config = join(root, '.phaseproof/config.json');
  const original = readFileSync(config, 'utf8');
  writeJson(config, { checks: ['true'] });
  assert.match(write(root, 'src/app.js').reason, /changed after phase 01 was approved/);
  assert.match(cli(root, 'gate').err, /checks or doc paths in \.phaseproof\/config\.json changed since phase 01 was approved/);
  assert.match(cli(root, 'status').out, /stale, checks or doc paths changed since approval/);
  writeJson(config, { ...JSON.parse(original), docPaths: ['docs/', 'phases/', 'design/', 'src/'] });
  assert.match(cli(root, 'gate').err, /changed since phase 01 was approved/);
  writeFileSync(config, original);
  assert.equal(cli(root, 'gate').code, 0);
});

test('approvals from before 0.5 have no config hash and are not refused for it', (t) => {
  const root = project(t);
  cli(root, 'approve');
  const a = readJson(approvalFile(root, '01'));
  delete a.configHash;
  writeJson(approvalFile(root, '01'), a);
  writeJson(join(root, '.phaseproof/config.json'), { checks: ['node -e "process.exit(0)"', 'node -e "1"'] });
  saveReview(root);
  assert.equal(cli(root, 'gate').code, 0);
});

test('editing tracked code after the review was saved refuses the gate and names the file', (t) => {
  const root = project(t);
  cli(root, 'approve');
  put(root, 'src/app.js', 'export const app = 2;\n');
  saveReview(root);
  assert.equal(isFingerprint(readJson(reviewRecordFile(root, '01'))?.fingerprint), true);
  put(root, 'src/app.js', 'export const app = 3;\n');
  const r = cli(root, 'gate');
  assert.equal(r.code, 1);
  assert.match(r.err, /code changed after the code review was saved: src\/app\.js\. Review the current code again/);
  saveReview(root);
  assert.equal(cli(root, 'gate').code, 0);
});

test('reverting or deleting reviewed code also counts as a change; docs and phaseproof files do not', (t) => {
  const root = project(t);
  cli(root, 'approve');
  put(root, 'src/app.js', 'export const app = 2;\n');
  put(root, 'src/new.js', 'export const n = 1;\n');
  saveReview(root);
  put(root, 'docs/notes.md', 'later notes\n');
  put(root, 'phases/phase-01-otp/progress.md', '# progress\n');
  put(root, 'docs/learnings.md', '- learned\n');
  assert.equal(reviewDrift(root, '01', readJson(approvalFile(root, '01')), PASS).changed.length, 0);
  git(root, 'checkout', '--', 'src/app.js');
  assert.deepEqual(reviewDrift(root, '01', readJson(approvalFile(root, '01')), PASS).changed, ['src/app.js']);
  rmSync(join(root, 'src/app.js'));
  rmSync(join(root, 'src/new.js'));
  assert.deepEqual(reviewDrift(root, '01', readJson(approvalFile(root, '01')), PASS), { changed: ['src/app.js'], fresh: ['src/new.js'] });
});

test('staging or committing reviewed code is not a change; a new untracked file only warns', (t) => {
  const root = project(t);
  cli(root, 'approve');
  put(root, 'src/app.js', 'export const app = 2;\n');
  put(root, 'src/new.js', 'export const n = 1;\n');
  saveReview(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'build');
  put(root, 'coverage-final.json', '{"run":1}');
  const r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /new or changed untracked file after the code review: coverage-final\.json/);
  assert.match(readJson(gateFile(root, '01')).testWarnings.join('\n'), /coverage-final\.json/);
});

test('a review saved without the Write tool, or replaced since it was recorded, warns instead of refusing', (t) => {
  const root = project(t);
  cli(root, 'approve');
  put(root, REVIEW, PASS);
  let r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /the code review was not fingerprinted when it was saved/);
  rmSync(gateFile(root, '01'));
  saveReview(root);
  put(root, 'src/app.js', 'changed after\n');
  put(root, REVIEW, `${PASS}\n- [minor] README.md:1 another\n`);
  r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /not fingerprinted/);
});

test('recordReview only records code reviews of tracked, approved phases', (t) => {
  const root = project(t);
  assert.equal(recordReview(root, join(root, REVIEW)), false);
  cli(root, 'approve');
  assert.equal(recordReview(root, join(root, REVIEW)), false);
  put(root, REVIEW, PASS);
  assert.equal(recordReview(root, join(root, '.phaseproof/reviews/phase-01-docs.md')), false);
  assert.equal(recordReview(root, join(root, 'src/app.js')), false);
  assert.equal(recordReview(root, '/elsewhere/.phaseproof/reviews/phase-01-code.md'), false);
  assert.equal(recordReview(root, join(root, REVIEW)), true);
  assert.equal(recordReview(tempProject(t), REVIEW), false);
});

test('the PostToolUse hook stays silent for file tools and survives junk', (t) => {
  const root = project(t);
  cli(root, 'approve');
  assert.equal(saveReview(root), '');
  assert.ok(readJson(reviewRecordFile(root, '01')));
  assert.equal(post(JSON.stringify({ cwd: root, tool_name: 'Edit', tool_input: {} }), root), '');
  assert.equal(post('nope', root), '');
});

test('fingerprints outside git, with bad bases, or of odd files', (t) => {
  assert.equal(codeFingerprint(tempProject(t), 'abc1234'), null);
  const root = project(t);
  assert.equal(codeFingerprint(root, 'not a sha'), null);
  assert.equal(codeFingerprint(root, undefined), null);
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  put(root, '__proto__', 'x');
  put(root, 'constructor', 'y');
  const fp = codeFingerprint(root, head);
  assert.equal(isFingerprint(fp), true);
  assert.equal(typeof fp.untracked.__proto__, 'string');
  assert.equal(isFingerprint({ tracked: [], untracked: {} }), false);
  assert.equal(isFingerprint(null), false);
  assert.deepEqual(driftSince(fp, fp), { changed: [], fresh: [] });
});

test('a project without git keeps working: no fingerprint, no extra warning', (t) => {
  const root = tempProject(t);
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-otp/scope.md', SCOPE);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(root, 'approve');
  saveReview(root);
  const r = cli(root, 'gate');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /fingerprinted/);
});
