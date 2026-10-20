import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeViolation, dirtyCodeFiles, ownerNotice, snapshot, verify } from '../scripts/lib/shell.mjs';
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

const changedBy = (root, id, act) => {
  assert.equal(snapshot(root, id), true);
  act();
  return verify(root, id);
};

test('init ignores snapshots', (t) => {
  assert.equal(read(closedRepo(t), '.phaseproof/.gitignore'), 'shell/\n');
});

test('dirtyCodeFiles skips docs, markdown and phaseproof records, and parses renames', (t) => {
  const root = closedRepo(t);
  put(root, 'src/new.js', 'new\n');
  put(root, 'docs/notes.txt', 'doc\n');
  put(root, 'NOTES.md', 'md\n');
  put(root, '.phaseproof/reviews/phase-01-docs.md', 'x');
  git(root, 'mv', 'src/a.js', 'src/b.js');
  assert.deepEqual(dirtyCodeFiles(root).sort(), ['src/a.js', 'src/b.js', 'src/new.js']);
  assert.equal(dirtyCodeFiles(tempProject(t)), null);
});

test('edits, new files and deletes are reported and no file is touched', (t) => {
  const root = closedRepo(t);
  put(root, 'src/keep.js', 'tracked\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'keep');
  const r = changedBy(root, 'e1', () => {
    put(root, 'src/a.js', 'by shell\n');
    put(root, 'src/new.js', 'sneaky\n');
    rmSync(join(root, 'src/keep.js'));
    put(root, 'docs/plan.txt', 'allowed\n');
  });
  assert.deepEqual(r.changed, ['src/a.js', 'src/keep.js', 'src/new.js']);
  assert.equal(read(root, 'src/a.js'), 'by shell\n');
  assert.equal(read(root, 'src/new.js'), 'sneaky\n');
  assert.equal(existsSync(join(root, '.phaseproof/quarantine')), false);
});

test('files that were already dirty only count when the command changes them', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'my own edit\n');
  assert.equal(changedBy(root, 'd1', () => {}), null);
  assert.deepEqual(changedBy(root, 'd2', () => put(root, 'src/a.js', 'by shell\n')).changed, ['src/a.js']);
});

test('glob characters are literal paths', (t) => {
  const root = closedRepo(t);
  put(root, 'src/[ab].js', 'route\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'route');
  put(root, 'src/a.js', 'my edit\n');
  assert.deepEqual(changedBy(root, 'g1', () => put(root, 'src/[ab].js', 'by shell\n')).changed, ['src/[ab].js']);
});

test('a retargeted symlink is reported', { skip: process.platform === 'win32' }, (t) => {
  const root = closedRepo(t);
  symlinkSync('a.js', join(root, 'src/link.js'));
  const r = changedBy(root, 'l1', () => {
    rmSync(join(root, 'src/link.js'));
    symlinkSync('/etc/hosts', join(root, 'src/link.js'));
  });
  assert.deepEqual(r.changed, ['src/link.js']);
});

test('a project inside a bigger repo only watches its own folder', (t) => {
  const top = tempProject(t);
  git(top, 'init', '-q');
  put(top, 'app/src/a.js', 'original\n');
  put(top, 'other/b.js', 'sibling\n');
  const app = join(top, 'app');
  cli(app, 'init');
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'init');
  const r = changedBy(app, 'm1', () => {
    put(app, 'src/a.js', 'by shell\n');
    put(app, 'docs/note.txt', 'allowed\n');
    put(app, '.phaseproof/runs/x.json', '{}');
    put(top, 'other/b.js', 'sibling edit\n');
  });
  assert.deepEqual(r.changed, ['src/a.js']);
});

test('commits made by the shell are reported, including the first commit', (t) => {
  const root = closedRepo(t);
  const r = changedBy(root, 'h1', () => {
    put(root, 'src/a.js', 'committed by shell\n');
    git(root, 'commit', '-qam', 'sneaky');
  });
  assert.deepEqual(r.committed, ['src/a.js']);
  assert.match(describeViolation('phase 01 is not approved', r), /HEAD moved during that command .* differs from before: src\/a\.js/);

  const fresh = tempProject(t);
  git(fresh, 'init', '-q');
  cli(fresh, 'init');
  const f = changedBy(fresh, 'h2', () => {
    put(fresh, 'src/x.js', 'x\n');
    git(fresh, 'add', '-A');
    git(fresh, 'commit', '-qm', 'first');
  });
  assert.deepEqual(f.committed, ['src/x.js']);
});

test('a nested repo does not switch the guard off', (t) => {
  const root = closedRepo(t);
  put(root, 'vendor/lib/x.js', 'x\n');
  git(join(root, 'vendor/lib'), 'init', '-q');
  assert.deepEqual(changedBy(root, 'n1', () => put(root, 'src/a.js', 'by shell\n')).changed, ['src/a.js']);
});

test('many dirty files fall back to size and mtime', (t) => {
  const root = closedRepo(t);
  for (let i = 0; i < 2100; i++) put(root, `gen/f${i}.js`, `${i}\n`);
  const started = Date.now();
  const r = changedBy(root, 'p1', () => put(root, 'gen/f7.js', 'changed and longer\n'));
  assert.deepEqual(r.changed, ['gen/f7.js']);
  assert.ok(Date.now() - started < 8000);
});

test('background commands are not snapshotted; corrupt snapshots are dropped', (t) => {
  const root = closedRepo(t);
  assert.equal(snapshot(root, 'b1', { background: true }), false);
  put(root, '.phaseproof/shell/bad.json', '{"entries":');
  assert.equal(verify(root, 'bad'), null);
  assert.equal(existsSync(join(root, '.phaseproof/shell/bad.json')), false);
});

test('projects from 0.2 get the gitignore on first snapshot, existing lines kept', (t) => {
  const root = closedRepo(t);
  writeFileSync(join(root, '.phaseproof/.gitignore'), 'custom/\n');
  snapshot(root, 'i1');
  assert.equal(read(root, '.phaseproof/.gitignore'), 'custom/\nshell/\n');
  assert.equal(readdirSync(join(root, '.phaseproof/shell')).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('hooks end to end: closed phase reports to Claude and the owner, open phase stays quiet', (t) => {
  const root = closedRepo(t);
  const input = (id, event) => JSON.stringify({ cwd: root, hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'x' } });
  pre(input('e1', 'PreToolUse'), root);
  put(root, 'src/a.js', 'x\n');
  const out = JSON.parse(post(input('e1', 'PostToolUse'), root));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /code changed during that shell command while code is closed: src\/a\.js/);
  assert.match(out.reason, /did not touch any file/);
  assert.match(out.systemMessage, /Claude was told to undo it/);

  pre(input('e2', 'PreToolUse'), root);
  put(root, 'src/a.js', 'y\n');
  const fail = JSON.parse(post(input('e2', 'PostToolUseFailure'), root));
  assert.equal(fail.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(fail.hookSpecificOutput.additionalContext, /src\/a\.js/);

  const open = approvedProject(t);
  git(open, 'init', '-q');
  const ob = JSON.stringify({ cwd: open, tool_name: 'Bash', tool_use_id: 'e3', tool_input: { command: 'x' } });
  pre(ob, open);
  put(open, 'src/b.js', 'fine\n');
  assert.equal(post(ob, open), '');
});

test('owner notice lists every file once', () => {
  assert.match(ownerNotice({ changed: ['a.js'], committed: ['a.js', 'b.js'] }), /\(a\.js, b\.js\)/);
});

test('post hook runs as a process and fails open', () => {
  const POST = fileURLToPath(new URL('../scripts/post.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [POST], { input: 'garbage', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('undoing a change back to the committed version is not reported', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'by shell\n');
  assert.equal(changedBy(root, 'u1', () => git(root, 'checkout', '--', 'src/a.js')), null);
  assert.equal(read(root, 'src/a.js'), 'original\n');
});

test('a symlinked snapshot folder or gitignore turns the guard off instead of writing through it', { skip: process.platform === 'win32' }, (t) => {
  const root = closedRepo(t);
  put(root, '.env', 'SECRET=1\n');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  for (const f of ['.env', 'README.md', 'src/a.js']) utimesSync(join(root, f), old, old);
  rmSync(join(root, '.phaseproof/shell'), { recursive: true, force: true });
  symlinkSync('..', join(root, '.phaseproof/shell'));
  assert.equal(snapshot(root, 'x1'), false);
  assert.equal(verify(root, 'x1'), null);
  for (const f of ['.env', 'README.md', 'src/a.js']) assert.equal(existsSync(join(root, f)), true, f);

  const other = closedRepo(t);
  put(other, 'src/conf.txt', 'conf\n');
  rmSync(join(other, '.phaseproof/.gitignore'));
  symlinkSync('../src/conf.txt', join(other, '.phaseproof/.gitignore'));
  assert.equal(snapshot(other, 'x2'), false);
  assert.equal(read(other, 'src/conf.txt'), 'conf\n');
});

test('prune only removes its own old snapshot files', (t) => {
  const root = closedRepo(t);
  mkdirSync(join(root, '.phaseproof/shell'), { recursive: true });
  put(root, '.phaseproof/shell/old.json', '{}');
  put(root, '.phaseproof/shell/keep-me.txt', 'not ours');
  put(root, '.phaseproof/shell/fresh.json', '{}');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(root, '.phaseproof/shell/old.json'), old, old);
  utimesSync(join(root, '.phaseproof/shell/keep-me.txt'), old, old);
  snapshot(root, 'pr1');
  const left = readdirSync(join(root, '.phaseproof/shell')).sort();
  assert.deepEqual(left, ['fresh.json', 'keep-me.txt', 'pr1.json']);
});

test('the message protects uncommitted work from a blanket undo', (t) => {
  const root = closedRepo(t);
  put(root, 'src/mine.js', 'tracked\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'mine');
  put(root, 'src/mine.js', 'owner work in progress\n');
  const r = changedBy(root, 'w1', () => {
    put(root, 'src/mine.js', 'owner work in progress\nshell line\n');
    put(root, 'src/a.js', 'by shell\n');
  });
  assert.deepEqual(r.hadWork, ['src/mine.js']);
  const m = describeViolation('closed', r);
  assert.match(m, /src\/a\.js had no uncommitted changes before the command/);
  assert.match(m, /src\/mine\.js already had the owner's uncommitted work before the command\. Do not run git checkout, restore, reset, stash or clean/);
  assert.match(m, /If you did not make a change, leave it alone/);
});
