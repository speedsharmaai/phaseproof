import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeViolation, dirtyCodeFiles, ownerNotice, snapshot, storeDir, verify } from '../scripts/lib/shell.mjs';
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

test('hooks end to end: closed phase reports to Claude and the owner, open phase stays quiet', (t) => {
  const root = closedRepo(t);
  const input = (id, event) => JSON.stringify({ cwd: root, hook_event_name: event, tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'x' } });
  pre(input('e1', 'PreToolUse'), root);
  put(root, 'src/a.js', 'x\n');
  const out = JSON.parse(post(input('e1', 'PostToolUse'), root));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /code changed during that shell command while code is closed: src\/a\.js/);
  assert.match(out.reason, /did not touch any file/);
  assert.match(out.reason, /Stop, tell the owner/);
  assert.match(out.systemMessage, /a shell command changed src\/a\.js\. phaseproof did not touch any file\. Claude was asked to stop and wait for you/);

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

test('post hook runs as a process and fails open', () => {
  const POST = fileURLToPath(new URL('../scripts/post.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [POST], { input: 'garbage', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a dirty file returned to its committed version is reported as discarded work, not as new code', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'owner work\n');
  const r = changedBy(root, 'u1', () => git(root, 'checkout', '--', 'src/a.js'));
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.discarded, ['src/a.js']);
  assert.match(describeViolation('closed', r), /uncommitted changes that existed before the command are gone now: src\/a\.js/);
});

test('moving owner work is reported on both paths and the message never advises a destructive fix', (t) => {
  const root = closedRepo(t);
  put(root, 'src/owner-new.js', 'only copy\n');
  const r = changedBy(root, 'w1', () => {
    put(root, 'src/moved.js', 'only copy\n');
    rmSync(join(root, 'src/owner-new.js'));
  });
  assert.deepEqual(r.changed, ['src/moved.js']);
  assert.deepEqual(r.discarded, ['src/owner-new.js']);
  const m = describeViolation('closed', r);
  assert.match(m, /Do not modify, restore, move or delete these files/);
  assert.doesNotMatch(m, /undo them|delete files you created|restore them from git/);
});

test('a committed rename reports both paths', (t) => {
  const root = closedRepo(t);
  const r = changedBy(root, 'k1', () => {
    git(root, 'mv', 'src/a.js', 'src/b.js');
    git(root, 'commit', '-qm', 'rename');
  });
  assert.deepEqual(r.committed.sort(), ['src/a.js', 'src/b.js']);
});

test('files over 1 MB are compared by size and mtime', (t) => {
  const root = closedRepo(t);
  put(root, 'big.bin', Buffer.alloc(1536 * 1024, 1));
  const r = changedBy(root, 'big1', () => put(root, 'big.bin', Buffer.alloc(1600 * 1024, 2)));
  assert.deepEqual(r.changed, ['big.bin']);
});

test('snapshots live inside .git, so git clean and stash cannot silence the report', (t) => {
  const root = closedRepo(t);
  assert.ok(storeDir(root).endsWith(join('.git', 'phaseproof')));
  put(root, 'src/owner.js', 'untracked owner work\n');
  const clean = changedBy(root, 'c1', () => git(root, 'clean', '-fdxq'));
  assert.deepEqual(clean.discarded, ['src/owner.js']);
  put(root, 'src/owner.js', 'again\n');
  put(root, 'src/a.js', 'edit\n');
  const stash = changedBy(root, 'c2', () => git(root, 'stash', '-a', '-q'));
  assert.deepEqual(stash.discarded, ['src/a.js', 'src/owner.js']);
});

test('the report survives the command deleting .phaseproof itself', (t) => {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'src/a.js', 'original\n');
  git(root, 'add', 'src');
  git(root, 'commit', '-qm', 'init');
  cli(root, 'init');
  put(root, 'src/owner.js', 'untracked\n');
  const id = JSON.stringify({ cwd: root, tool_name: 'Bash', tool_use_id: 'gc1', tool_input: { command: 'git clean -fd' } });
  pre(id, root);
  git(root, 'clean', '-fdq');
  assert.equal(existsSync(join(root, '.phaseproof')), false);
  const out = JSON.parse(post(id, root));
  assert.match(out.reason, /gone now: src\/owner\.js/);
});

test('a symlinked store turns the guard off and deletes nothing', { skip: process.platform === 'win32' }, (t) => {
  const root = closedRepo(t);
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(root, 'src/a.js'), old, old);
  rmSync(join(root, '.git/phaseproof'), { recursive: true, force: true });
  symlinkSync(join(root, 'src'), join(root, '.git/phaseproof'));
  assert.equal(storeDir(root), null);
  assert.equal(snapshot(root, 'x1'), false);
  assert.equal(verify(root, 'x1'), null);
  assert.equal(read(root, 'src/a.js'), 'original\n');
});

test('prune only removes its own old snapshot files, and corrupt snapshots are dropped', (t) => {
  const root = closedRepo(t);
  snapshot(root, 'seed');
  const dir = storeDir(root);
  const mine = readdirSync(dir).find((n) => n.endsWith('-seed.json'));
  const key = mine.slice(0, 12);
  put(dir, `${key}-old.json`, '{}');
  put(dir, 'keep-me.json', 'not ours');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(join(dir, `${key}-old.json`), old, old);
  utimesSync(join(dir, 'keep-me.json'), old, old);
  snapshot(root, 'pr1');
  assert.deepEqual(readdirSync(dir).sort(), [`${key}-pr1.json`, `${key}-seed.json`, 'keep-me.json'].sort());
  put(dir, `${key}-bad.json`, '{"entries":');
  assert.equal(verify(root, 'bad'), null);
  assert.equal(existsSync(join(dir, `${key}-bad.json`)), false);
  assert.equal(snapshot(root, 'b1', { background: true }), false);
});

test('a symlink or hardlink planted at the temp snapshot name is never written through', { skip: process.platform === 'win32' }, (t) => {
  const root = closedRepo(t);
  snapshot(root, 'seed');
  const dir = storeDir(root);
  const key = readdirSync(dir)[0].slice(0, 12);
  symlinkSync(join(root, 'src/a.js'), join(dir, `${key}-j1.json.tmp`));
  linkSync(join(root, 'README.md'), join(dir, `${key}-j2.json.tmp`));
  assert.equal(snapshot(root, 'j1'), true);
  assert.equal(snapshot(root, 'j2'), true);
  assert.equal(read(root, 'src/a.js'), 'original\n');
  assert.equal(read(root, 'README.md'), '# x\n');
});

test('owner work committed by the shell is reported once, as committed', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'owner work\n');
  const r = changedBy(root, 'oc1', () => git(root, 'commit', '-qam', 'took it'));
  assert.deepEqual(r.discarded, []);
  assert.deepEqual(r.committed, ['src/a.js']);
});

test('the owner notice says what happened to their work', () => {
  const n = ownerNotice({ changed: [], discarded: ['src/a.js'], committed: [] });
  assert.match(n, /wiped your uncommitted changes in src\/a\.js/);
  assert.match(n, /phaseproof did not touch any file/);
  assert.doesNotMatch(ownerNotice({ changed: ['b.js'], discarded: [], committed: [] }), /wiped/);
});

test('the message gives no next step beyond stopping', (t) => {
  const r = { changed: ['src/a.js'], discarded: [], committed: [] };
  const m = describeViolation('phaseproof: phase 01 is not approved, so code stays closed. Finish and review the phase docs, then the owner runs /phaseproof:approve 01.', r);
  assert.match(m, /Code is closed because phase 01 is not approved, so code stays closed\.$/);
  assert.doesNotMatch(m, /Finish and review/);
});

test('owner work destroyed by a reset or forced checkout is reported as wiped, not just as a HEAD move', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'v2\n');
  git(root, 'commit', '-qam', 'v2');
  put(root, 'src/a.js', 'OWNER WORK\n');
  const r = changedBy(root, 'rh1', () => git(root, 'reset', '-q', '--hard', 'HEAD~1'));
  assert.deepEqual(r.discarded, ['src/a.js']);
  assert.match(ownerNotice(r), /wiped your uncommitted changes in src\/a\.js/);
});

test('overwriting a file the owner had changed says so', (t) => {
  const root = closedRepo(t);
  put(root, 'src/a.js', 'OWNER UNCOMMITTED\n');
  const r = changedBy(root, 'ow1', () => put(root, 'src/a.js', 'claude\n'));
  assert.deepEqual(r.overwritten, ['src/a.js']);
  assert.match(ownerNotice(r), /overwrote your uncommitted changes in src\/a\.js/);
  assert.match(describeViolation('closed', r), /already had the owner's uncommitted changes, and the command overwrote them/);
});

test('a dirty file that only became ignored is not reported as wiped', (t) => {
  const root = closedRepo(t);
  put(root, 'src/own.js', 'mine\n');
  const r = changedBy(root, 'ig1', () => writeFileSync(join(root, '.git/info/exclude'), 'src/own.js\n'));
  assert.equal(r, null);
});

test('when the command deletes .phaseproof the reason says the phase was closed', (t) => {
  const root = closedRepo(t);
  const id = JSON.stringify({ cwd: root, tool_name: 'Bash', tool_use_id: 'dp1', tool_input: { command: 'x' } });
  pre(id, root);
  rmSync(join(root, '.phaseproof'), { recursive: true, force: true });
  put(root, 'src/a.js', 'changed\n');
  assert.match(JSON.parse(post(id, root)).reason, /Code is closed because the phase was closed when the command started\./);
});

test('a forced checkout over owner work reports it wiped, unless the target branch holds that exact work', (t) => {
  const root = closedRepo(t);
  const base = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  git(root, 'checkout', '-qb', 'other');
  put(root, 'src/a.js', 'OWNER WORK\n');
  git(root, 'commit', '-qam', 'other has it');
  git(root, 'checkout', '-q', base);
  git(root, 'checkout', '-qb', 'third');
  put(root, 'src/a.js', 'third\n');
  git(root, 'commit', '-qam', 'third');
  git(root, 'checkout', '-q', base);
  put(root, 'src/a.js', 'OWNER WORK\n');
  const kept = changedBy(root, 'cf1', () => git(root, 'checkout', '-qf', 'other'));
  assert.deepEqual(kept.discarded, []);
  assert.deepEqual(kept.committed, ['src/a.js']);
  assert.match(ownerNotice(kept), /moved HEAD, so the committed code in src\/a\.js is different/);

  put(root, 'src/a.js', 'MORE OWNER WORK\n');
  const lost = changedBy(root, 'cf2', () => git(root, 'checkout', '-qf', 'third'));
  assert.deepEqual(lost.discarded, ['src/a.js']);
  assert.match(ownerNotice(lost), /wiped your uncommitted changes in src\/a\.js; moved HEAD/);
});

test('mass wipes are checked against HEAD in one pass', (t) => {
  const root = closedRepo(t);
  for (let i = 0; i < 600; i++) put(root, `src/g${i}.js`, `${i}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'many');
  for (let i = 0; i < 600; i++) put(root, `src/g${i}.js`, `owner ${i}\n`);
  const started = Date.now();
  const r = changedBy(root, 'mw1', () => git(root, 'reset', '-q', '--hard'));
  assert.equal(r.discarded.length, 600);
  assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
});
