import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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

test('glob characters in names are literal paths, never patterns', (t) => {
  const root = closedRepo(t);
  put(root, 'src/[ab].js', 'route\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'route');
  put(root, 'src/a.js', 'my own edit\n');
  snapshot(root, 'g1');
  put(root, 'src/[ab].js', 'by shell\n');
  const r = verify(root, 'g1');
  assert.deepEqual(r.restored, ['src/[ab].js']);
  assert.equal(read(root, 'src/[ab].js'), 'route\n');
  assert.equal(read(root, 'src/a.js'), 'my own edit\n');
});

test('a failure partway through never loses the state from before the command', (t) => {
  const root = closedRepo(t);
  put(root, 'src/z.js', 'USER WORK\n');
  snapshot(root, 'f1');
  put(root, 'src/z.js', 'SHELL\n');
  put(root, 'lib/x/inner.js', 'nested\n');
  git(join(root, 'lib/x'), 'init', '-q');
  const r = verify(root, 'f1');
  assert.equal(read(root, 'src/z.js'), 'USER WORK\n');
  assert.ok(r.unchecked.includes('lib/x'));
  const saved = JSON.parse(read(root, `${r.quarantine}/snapshot-before.json`));
  assert.equal(Buffer.from(saved.entries.find((e) => e.rel === 'src/z.js').content, 'base64').toString(), 'USER WORK\n');
});

test('symlinks are reported, never written through', { skip: process.platform === 'win32' }, (t) => {
  const root = closedRepo(t);
  const outside = tempProject(t);
  put(outside, 'precious.txt', 'PRECIOUS\n');
  put(root, 'src/t1.js', 't1\n');
  symlinkSync('t1.js', join(root, 'src/link.js'));
  snapshot(root, 's1');
  rmSync(join(root, 'src/link.js'));
  symlinkSync(join(outside, 'precious.txt'), join(root, 'src/link.js'));
  const r = verify(root, 's1');
  assert.deepEqual(r.unchecked, ['src/link.js']);
  assert.equal(read(outside, 'precious.txt'), 'PRECIOUS\n');
});

test('a project inside a bigger repo only guards its own folder', (t) => {
  const top = tempProject(t);
  git(top, 'init', '-q');
  put(top, 'app/src/a.js', 'original\n');
  put(top, 'other/b.js', 'sibling\n');
  const app = join(top, 'app');
  cli(app, 'init');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'init');
  put(top, 'other/b.js', 'sibling edit\n');
  snapshot(app, 'm1');
  put(app, 'src/a.js', 'by shell\n');
  put(app, 'docs/note.txt', 'allowed\n');
  put(app, '.phaseproof/runs/x.json', '{}');
  const r = verify(app, 'm1');
  assert.deepEqual(r.changed, ['src/a.js']);
  assert.deepEqual(r.restored, ['src/a.js']);
  assert.equal(read(app, 'src/a.js'), 'original\n');
  assert.equal(read(app, 'docs/note.txt'), 'allowed\n');
  assert.equal(read(top, 'other/b.js'), 'sibling edit\n');
});

test('a commit made by the shell is reported, not reverted', (t) => {
  const root = closedRepo(t);
  snapshot(root, 'h1');
  put(root, 'src/a.js', 'committed by shell\n');
  git(root, 'commit', '-qam', 'sneaky');
  const r = verify(root, 'h1');
  assert.equal(r.mode, 'head-moved');
  assert.deepEqual(r.changed, ['src/a.js']);
  assert.equal(read(root, 'src/a.js'), 'committed by shell\n');
  assert.match(describeViolation('phase 01 is not approved', r), /moved HEAD/);
});

test('a soft reset touches no files and deletes nothing', (t) => {
  const root = closedRepo(t);
  put(root, 'src/n.js', 'new\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'second');
  snapshot(root, 'h2');
  git(root, 'reset', '--soft', 'HEAD~1');
  verify(root, 'h2');
  assert.equal(read(root, 'src/n.js'), 'new\n');
});

test('a nested repo already present does not switch the guard off', (t) => {
  const root = closedRepo(t);
  put(root, 'vendor/lib/x.js', 'x\n');
  git(join(root, 'vendor/lib'), 'init', '-q');
  assert.equal(snapshot(root, 'n1'), true);
  put(root, 'src/a.js', 'by shell\n');
  assert.deepEqual(verify(root, 'n1').restored, ['src/a.js']);
});

test('two shell calls at once: report, do not guess', (t) => {
  const root = closedRepo(t);
  snapshot(root, 'c1');
  snapshot(root, 'c2');
  put(root, 'src/a.js', 'by one of them\n');
  const r = verify(root, 'c1');
  assert.equal(r.mode, 'concurrent');
  assert.equal(read(root, 'src/a.js'), 'by one of them\n');
  assert.match(describeViolation('closed', r), /another shell command was running/);
});

test('background commands are not snapshotted', (t) => {
  const root = closedRepo(t);
  assert.equal(snapshot(root, 'b1', { background: true }), false);
});

test('a failing shell command is still caught and reported as extra context', (t) => {
  const root = closedRepo(t);
  const input = (event) => JSON.stringify({ cwd: root, hook_event_name: event, tool_name: 'Bash', tool_use_id: 'pf1', tool_input: { command: 'x' } });
  pre(input('PreToolUse'), root);
  put(root, 'src/a.js', 'by shell then exit 1\n');
  const out = JSON.parse(post(input('PostToolUseFailure'), root));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(out.hookSpecificOutput.additionalContext, /Rolled back: src\/a\.js/);
  assert.equal(read(root, 'src/a.js'), 'original\n');
});

test('projects from 0.2 get the gitignore on first snapshot, existing lines kept', (t) => {
  const root = closedRepo(t);
  put(root, '.phaseproof/.gitignore', 'custom/\n');
  snapshot(root, 'i1');
  assert.equal(read(root, '.phaseproof/.gitignore'), 'custom/\nshell/\nquarantine/\n');
});

test('renames are parsed and fully undone, index included', (t) => {
  const root = closedRepo(t);
  snapshot(root, 'r1');
  git(root, 'mv', 'src/a.js', 'src/b.js');
  assert.deepEqual(dirtyCodeFiles(root).sort(), ['src/a.js', 'src/b.js']);
  verify(root, 'r1');
  assert.equal(read(root, 'src/a.js'), 'original\n');
  assert.equal(existsSync(join(root, 'src/b.js')), false);
  assert.equal(git(root, 'status', '--porcelain', '--', 'src').stdout, '');
});

test('small source edits are snapshotted before big artifacts use the budget', (t) => {
  const root = closedRepo(t);
  put(root, 'build.bin', Buffer.alloc(6 * 1024 * 1024, 1));
  put(root, 'src/a.js', 'small edit\n');
  snapshot(root, 'z1');
  put(root, 'src/a.js', 'by shell\n');
  put(root, 'build.bin', Buffer.alloc(6 * 1024 * 1024, 2));
  const r = verify(root, 'z1');
  assert.equal(read(root, 'src/a.js'), 'small edit\n');
  assert.deepEqual(r.failed, [{ rel: 'build.bin', why: 'too large to snapshot' }]);
});

test('many new files roll back in batches', (t) => {
  const root = closedRepo(t);
  snapshot(root, 'p1');
  for (let i = 0; i < 400; i++) put(root, `gen/f${i}.js`, `${i}\n`);
  const started = Date.now();
  const r = verify(root, 'p1');
  assert.equal(r.restored.length, 400);
  assert.equal(existsSync(join(root, 'gen')), false);
  assert.ok(Date.now() - started < 20000);
});
