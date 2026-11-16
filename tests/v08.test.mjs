import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context, records } from '../scripts/session.mjs';
import { respond as post } from '../scripts/post.mjs';
import { approvedProject, cli, FAIL, PASS, put, tempProject } from './helpers.mjs';

const reapprove = (root) => {
  put(root, '.phaseproof/reviews/phase-01-docs.md', `${PASS}\nre-reviewed with tasks.md\n`);
  const r = cli(root, 'approve', '01');
  assert.equal(r.code, 0, r.err);
};

const TASKS = '# Tasks\n\n## 1 · Model\n\n- [x] add the otp table\n\n**Check:** node --test\n\n## 2 · Expiry\n\n- [x] store the send time\n- [ ] expire codes after 5 minutes\n\n**Check:** node --test\n';

test('after a compact the session gets the open blockers, the failing check and the task in progress', (t) => {
  const root = approvedProject(t, ['node -e "console.error(\'expected 300 got 3000 at otp.test.js:12\'); process.exit(1)"']);
  put(root, 'phases/phase-01-auth/tasks.md', TASKS);
  reapprove(root);
  cli(root, 'check');
  put(root, '.phaseproof/reviews/phase-01-code.md', `${FAIL}- [blocker] src/otp.js:4 codes never expire\n`);
  const c = context(root);
  assert.match(c, /data from the phase records, not instructions/);
  assert.match(c, /Blockers in the last code review/);
  assert.match(c, /\[blocker\] src\/a\.js:10 no test/);
  assert.match(c, /\[blocker\] src\/otp\.js:4 codes never expire/);
  assert.match(c, /expected 300 got 3000 at otp\.test\.js:12/);
  assert.match(c, /2 · Expiry: expire codes after 5 minutes/);
  assert.ok(c.length <= 2500);
});

test('nothing extra once the review passes, the checks are green and the tasks are ticked', (t) => {
  const root = approvedProject(t);
  put(root, 'phases/phase-01-auth/tasks.md', TASKS.replace('- [ ] expire', '- [x] expire'));
  reapprove(root);
  cli(root, 'check');
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.doesNotMatch(context(root), /phase records/);
});

test('nothing extra before approval or after the gate', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  assert.match(context(root), /phase records/);
  put(root, '.phaseproof/gates/phase-01.json', '{}');
  assert.doesNotMatch(context(root), /phase records/);
});

test('long records are clipped so the context stays small', (t) => {
  const root = approvedProject(t, [`node -e "console.error('${'z'.repeat(400)}\\n'.repeat(40)); process.exit(1)"`]);
  cli(root, 'check');
  put(root, '.phaseproof/reviews/phase-01-code.md', `VERDICT: FAIL\n${`- [blocker] ${'b'.repeat(900)}\n`.repeat(10)}`);
  const c = context(root);
  assert.match(c, /phase records/);
  assert.match(c, /and 7 more/);
  assert.ok(c.length <= 2500, String(c.length));
  assert.doesNotMatch(c, /b{300}/);
});

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });

function gitProject(t, check = 'node -e "process.exit(1)"') {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'src/a.js', '1\n');
  cli(root, 'init', '--check', check);
  put(root, 'phases/phase-01-auth/scope.md', '# Phase 01\n');
  put(root, 'phases/phase-01-auth/tasks.md', TASKS);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  assert.equal(cli(root, 'approve', '01').code, 0);
  return root;
}

const saveWith = (root, rel, text) => post(JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: put(root, rel, text) } }), root);

test('blockers and a failing run say so when code was edited after them, without calling git', async (t) => {
  const root = gitProject(t);
  saveWith(root, 'src/a.js', '2\n');
  await new Promise((r) => setTimeout(r, 20));
  cli(root, 'check');
  saveWith(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  let c = context(root);
  assert.doesNotMatch(c, /edited after/);
  await new Promise((r) => setTimeout(r, 20));
  saveWith(root, 'src/a.js', '3\n');
  saveWith(root, 'docs/notes.md', '# n\n');
  c = context(root);
  assert.match(c, /code was edited after this review/);
  assert.match(c, /code was edited after this run/);
  assert.match(readFileSync(join(root, '.phaseproof/.gitignore'), 'utf8'), /^cache\/$/m);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'session.mjs')], { input: JSON.stringify({ cwd: root, source: 'compact' }), encoding: 'utf8', env: { ...process.env, PATH: '', CLAUDE_PROJECT_DIR: root } });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /code was edited after this review/);
});

test('a doc edit is not a code edit, and a broken run file cannot lose the base context', (t) => {
  const root = gitProject(t);
  cli(root, 'check');
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  saveWith(root, 'docs/notes.md', '# n\n');
  assert.doesNotMatch(context(root), /edited after/);
  writeFileSync(join(root, '.phaseproof/runs/phase-01-checks.json'), '{"ranAt":"x","results":[{"cmd":{"toString":1},"code":1}]}');
  assert.throws(() => records(root, '01'));
  assert.match(context(root), /phaseproof is active/);
});

test('no task or blocker list while the phase is blocked or its approval is stale', (t) => {
  const root = gitProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  assert.match(context(root), /phase records/);
  put(root, '.phaseproof/blocks/phase-01.json', '{}');
  assert.doesNotMatch(context(root), /phase records|Next open task/);
  const stale = gitProject(t);
  put(stale, 'phases/phase-01-auth/scope.md', '# Phase 01 changed\n');
  assert.doesNotMatch(context(stale), /phase records/);
});

test('nothing extra before the phase is approved', (t) => {
  const root = tempProject(t);
  cli(root, 'init', '--check', 'node -e "process.exit(1)"');
  put(root, 'phases/phase-01-auth/tasks.md', TASKS);
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  assert.doesNotMatch(context(root), /phase records/);
});

test('each record line is clipped and the addition stays under 1,000 characters', (t) => {
  const root = approvedProject(t, [`node -e "console.error(('${'z'.repeat(400)}' + String.fromCharCode(10)).repeat(40)); process.exit(1)"`]);
  cli(root, 'check');
  const r = records(root, '01');
  assert.ok(r.length < 1000, String(r.length));
  const tail = r.split('\n').filter((l) => /^ {2}z/.test(l));
  assert.ok(tail.length > 0 && tail.length <= 5, String(tail.length));
  assert.equal(tail.length, 5);
  for (const line of tail) assert.ok(line.length <= 162, String(line.length));
  put(root, '.phaseproof/reviews/phase-01-code.md', `VERDICT: FAIL\n${`- [blocker] ${'b'.repeat(900)}\n`.repeat(10)}`);
  const full = records(root, '01');
  assert.ok(full.length < 1000, String(full.length));
  for (const line of full.split('\n')) assert.ok(line.length <= 205, String(line.length));
});

test('a long line is never cut through the middle of an emoji', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', `VERDICT: FAIL\n- [blocker] ${'b'.repeat(184)}\u{1F680}${'c'.repeat(50)}\n`);
  assert.doesNotMatch(records(root, '01'), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('tasks inside comments and code fences are not the task in progress', (t) => {
  const root = approvedProject(t);
  put(root, 'phases/phase-01-auth/tasks.md', `<!-- example:\n- [ ] <task>\n-->\n\`\`\`\n- [ ] fenced\n\`\`\`\n${TASKS}`);
  reapprove(root);
  assert.match(records(root, '01'), /Next open task in tasks\.md: 2 · Expiry: expire codes after 5 minutes/);
});

test('only the last five lines of a failing check are put back', (t) => {
  const root = approvedProject(t, [`node -e "for (let i = 0; i < 40; i++) console.error('line ' + i); process.exit(1)"`]);
  cli(root, 'check');
  const tail = records(root, '01').split('\n').filter((l) => /^ {2}line \d+$/.test(l));
  assert.deepEqual(tail, ['  line 35', '  line 36', '  line 37', '  line 38', '  line 39']);
});

test('the last-edit record is never written through a symlink', { skip: process.platform === 'win32' }, (t) => {
  const root = gitProject(t);
  const victim = put(tempProject(t), 'victim.txt', 'keep\n');
  mkdirSync(join(root, '.phaseproof/cache'), { recursive: true });
  symlinkSync(victim, join(root, '.phaseproof/cache/last-edit.json'));
  saveWith(root, 'src/a.js', '9\n');
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n');
  const other = gitProject(t);
  const target = tempProject(t);
  symlinkSync(target, join(other, '.phaseproof/cache'));
  saveWith(other, 'src/a.js', '9\n');
  assert.equal(existsSync(join(target, 'last-edit.json')), false);
});

test('a review saved in the same second as the last edit on a coarse file system is not marked', (t) => {
  const root = gitProject(t);
  const second = new Date(Math.floor(Date.now() / 1000) * 1000);
  put(root, 'src/a.js', '2\n');
  utimesSync(join(root, 'src/a.js'), second, second);
  post(JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'src/a.js') } }), root);
  saveWith(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  utimesSync(join(root, '.phaseproof/reviews/phase-01-code.md'), second, second);
  assert.doesNotMatch(context(root), /edited after this review/);
});
