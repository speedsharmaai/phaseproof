import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('blockers and a failing run say so when the code changed after them', (t) => {
  const root = gitProject(t);
  put(root, 'src/a.js', '2\n');
  cli(root, 'check');
  const file = put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  post(JSON.stringify({ cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } }), root);
  let c = context(root);
  assert.doesNotMatch(c, /code changed after/);
  put(root, 'src/a.js', '3\n');
  c = context(root);
  assert.match(c, /code changed after this review/);
  assert.match(c, /code changed after this run/);
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
  put(root, '.phaseproof/reviews/phase-01-code.md', `VERDICT: FAIL\n${`- [blocker] ${'b'.repeat(900)}\n`.repeat(10)}`);
  const r = records(root, '01');
  assert.ok(r.length < 1000, String(r.length));
  const tail = r.split('\n').filter((l) => /^ {2}z/.test(l));
  assert.ok(tail.length > 0 && tail.length <= 5, String(tail.length));
  for (const line of r.split('\n')) assert.ok(line.length <= 205, String(line.length));
});

test('a long line is never cut through the middle of an emoji', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', `VERDICT: FAIL\n- [blocker] ${'b'.repeat(184)}\u{1F680}\n`);
  assert.doesNotMatch(records(root, '01'), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('tasks inside comments and code fences are not the task in progress', (t) => {
  const root = approvedProject(t);
  put(root, 'phases/phase-01-auth/tasks.md', `<!-- example:\n- [ ] <task>\n-->\n\`\`\`\n- [ ] fenced\n\`\`\`\n${TASKS}`);
  reapprove(root);
  assert.match(records(root, '01'), /Next open task in tasks\.md: 2 · Expiry: expire codes after 5 minutes/);
});
