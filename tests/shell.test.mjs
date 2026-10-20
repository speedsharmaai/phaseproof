import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeViolation, dirtyCodeFiles, snapshot, verify } from '../scripts/lib/shell.mjs';
import { respond as pre } from '../scripts/hook.mjs';
import { respond as post } from '../scripts/post.mjs';
import { approvedProject, cli, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

function closedRepo(t) {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'src/a.js', 'original\n');
  put(root, 'README.md', '# x\n');
  cli(root, 'init');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('init ignores snapshots and quarantine', (t) => {
  const root = closedRepo(t);
  assert.equal(read(root, '.phaseproof/.gitignore'), 'shell/\nquarantine/\n');
});

test('dirtyCodeFiles skips docs, markdown and phaseproof records', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'changed\n');
  put(root, 'src/new.js', 'new\n');
  put(root, 'docs/notes.txt', 'doc\n');
  put(root, 'NOTES.md', 'md\n');
  put(root, '.phaseproof/reviews/phase-01-docs.md', 'x');
  assert.deepEqual(dirtyCodeFiles(root).sort(), ['src/a.js', 'src/new.js']);
});

test('dirtyCodeFiles is null outside git', (t) => {
  assert.equal(dirtyCodeFiles(tempProject(t)), null);
});

test('shell edits to clean and new files are rolled back and quarantined', (t) => {
  const root = closedRepo(t);
  assert.equal(snapshot(root, 'tu1'), true);
  put(root, 'src/a.js', 'by shell\n');
  put(root, 'src/new.js', 'sneaky\n');
  put(root, 'docs/plan.txt', 'allowed\n');
  const r = verify(root, 'tu1');
  assert.deepEqual(r.changed, ['src/a.js', 'src/new.js']);
  assert.deepEqual(r.restored, ['src/a.js', 'src/new.js']);
  assert.equal(read(root, 'src/a.js'), 'original\n');
  assert.equal(existsSync(join(root, 'src/new.js')), false);
  assert.equal(read(root, `${r.quarantine}/src/a.js`), 'by shell\n');
  assert.equal(read(root, `${r.quarantine}/src/new.js`), 'sneaky\n');
  assert.equal(read(root, 'docs/plan.txt'), 'allowed\n');
});

test('uncommitted work from before the command is put back, not wiped', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'my own edit\n');
  snapshot(root, 'tu2');
  put(root, 'src/a.js', 'by shell\n');
  verify(root, 'tu2');
  assert.equal(read(root, 'src/a.js'), 'my own edit\n');
});

test('a file deleted by the shell comes back', (t) => {
  const root = closedRepo(t);
  snapshot(root, 'tu3');
  rmSync(join(root, 'src/a.js'));
  const r = verify(root, 'tu3');
  assert.deepEqual(r.restored, ['src/a.js']);
  assert.equal(read(root, 'src/a.js'), 'original\n');
});

test('nothing changed means nothing to report', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'dirty before\n');
  snapshot(root, 'tu4');
  assert.equal(verify(root, 'tu4'), null);
  assert.equal(verify(root, 'never-snapshotted'), null);
});

test('warn mode reports without rolling back, off mode takes no snapshot', (t) => {
  const root = closedRepo(t);
  put(root, '.phaseproof/config.json', JSON.stringify({ checks: [], shellGuard: 'warn' }));
  snapshot(root, 'tu5');
  put(root, 'src/a.js', 'by shell\n');
  const r = verify(root, 'tu5');
  assert.equal(r.mode, 'warn');
  assert.equal(read(root, 'src/a.js'), 'by shell\n');
  assert.match(describeViolation('phase 01 is not approved', r), /Nothing was rolled back/);
  put(root, '.phaseproof/config.json', JSON.stringify({ checks: [], shellGuard: 'off' }));
  assert.equal(snapshot(root, 'tu6'), false);
});

test('hooks end to end: closed phase rolls back, open phase leaves the shell alone', (t) => {
  const root = closedRepo(t);
  const bash = (id) => JSON.stringify({ cwd: root, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'echo x > src/a.js' } });
  assert.equal(pre(bash('e1'), root), '');
  put(root, 'src/a.js', 'x\n');
  const out = JSON.parse(post(bash('e1'), root));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /changed code while code is closed \(src\/a\.js\)/);
  assert.match(out.reason, /phase 01 is not approved/);
  assert.equal(read(root, 'src/a.js'), 'original\n');

  const open = approvedProject(t);
  git(open, 'init', '-q');
  const ob = JSON.stringify({ cwd: open, tool_name: 'Bash', tool_use_id: 'e2', tool_input: { command: 'touch src/b.js' } });
  pre(ob, open);
  put(open, 'src/b.js', 'fine\n');
  assert.equal(post(ob, open), '');
  assert.equal(read(open, 'src/b.js'), 'fine\n');
});

test('post hook runs as a process and fails open', () => {
  const POST = fileURLToPath(new URL('../scripts/post.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [POST], { input: 'garbage', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
