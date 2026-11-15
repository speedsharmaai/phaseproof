import { test } from 'node:test';
import assert from 'node:assert/strict';
import { context } from '../scripts/session.mjs';
import { approvedProject, cli, FAIL, PASS, put } from './helpers.mjs';

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
