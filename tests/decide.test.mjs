import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { decide, toProjectPath } from '../scripts/lib/decide.mjs';
import { approvedProject, cli, FAIL, PASS, put, tempProject } from './helpers.mjs';

const write = (root, file) => decide({ root, toolName: 'Write', toolInput: { file_path: file } });
const bash = (root, command) => decide({ root, toolName: 'Bash', toolInput: { command } });

test('does nothing in a project that is not tracked', (t) => {
  const root = tempProject(t);
  assert.equal(write(root, join(root, 'src/index.js')).allow, true);
  assert.equal(bash(root, 'rm -rf .phaseproof/gates').allow, true);
});

test('does nothing when root is missing', () => {
  assert.equal(decide({ root: undefined, toolName: 'Write', toolInput: { file_path: '/x' } }).allow, true);
});

test('blocks code before approval but allows docs', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  const code = write(root, join(root, 'src/index.js'));
  assert.equal(code.allow, false);
  assert.match(code.reason, /phase 01 is not approved/);
  for (const doc of ['docs/brief.md', 'phases/phase-01-auth/scope.md', 'docs/design/exports/home.png', 'README.md', 'packages/api/NOTES.md']) {
    assert.equal(write(root, join(root, doc)).allow, true, doc);
  }
});

test('relative paths resolve against the project', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.equal(write(root, 'src/index.js').allow, false);
  assert.equal(write(root, 'docs/x.md').allow, true);
});

test('files outside the project are not its business', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.equal(write(root, join(root, '..', 'elsewhere', 'a.js')).allow, true);
});

test('opens code once the phase is approved', (t) => {
  const root = approvedProject(t);
  assert.equal(write(root, join(root, 'src/index.js')).allow, true);
  assert.equal(decide({ root, toolName: 'NotebookEdit', toolInput: { notebook_path: join(root, 'nb.ipynb') } }).allow, true);
});

test('closes code again after the gate passes', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.equal(cli(root, 'gate', '01').code, 0);
  const r = write(root, join(root, 'src/index.js'));
  assert.equal(r.allow, false);
  assert.match(r.reason, /already passed its gate/);
});

test('records under .phaseproof are script-only, reviews and config are not', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  for (const rel of ['.phaseproof/gates/phase-01.json', '.phaseproof/approvals/phase-01.json', '.phaseproof/state.json', '.phaseproof/runs/x.json']) {
    assert.equal(write(root, join(root, rel)).allow, false, rel);
  }
  assert.equal(write(root, join(root, '.phaseproof/reviews/phase-01-code.md')).allow, true);
  assert.equal(write(root, join(root, '.phaseproof/config.json')).allow, true);
});

test('bash cannot touch records or approve', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.equal(bash(root, 'echo {} > .phaseproof/gates/phase-01.json').allow, false);
  assert.equal(bash(root, 'cp x .phaseproof\\approvals\\p.json').allow, false);
  assert.equal(bash(root, 'node "/p/scripts/phaseproof.mjs" approve 01').allow, false);
  assert.equal(bash(root, 'node /p/scripts/phaseproof.mjs gate 01').allow, true);
  assert.equal(bash(root, 'pnpm test').allow, true);
});

test('other tools pass through', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.equal(decide({ root, toolName: 'Read', toolInput: { file_path: join(root, 'src/a.js') } }).allow, true);
  assert.equal(decide({ root, toolName: 'Write', toolInput: {} }).allow, true);
});

test('toProjectPath', () => {
  assert.equal(toProjectPath('/a/b', '/a/b/c/d.js'), 'c/d.js');
  assert.equal(toProjectPath('/a/b', 'c.js'), 'c.js');
  assert.equal(toProjectPath('/a/b', '/a/x.js'), null);
  assert.equal(toProjectPath('/a/b', '/a/b'), null);
});

test('a blocked phase keeps code closed until it is approved again', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  assert.equal(cli(root, 'block').code, 0);
  const r = write(root, join(root, 'src/index.js'));
  assert.equal(r.allow, false);
  assert.match(r.reason, /blocked after two failed code reviews/);
  assert.equal(cli(root, 'approve', '01').code, 0);
  assert.equal(write(root, join(root, 'src/index.js')).allow, true);
});

test('editing scope after approval closes code', (t) => {
  const root = approvedProject(t);
  put(root, 'phases/phase-01-auth/scope.md', '# Phase 01\nnow with more scope\n');
  const r = write(root, join(root, 'src/index.js'));
  assert.equal(r.allow, false);
  assert.match(r.reason, /scope changed after it was approved/);
});

test('approvals from 0.1 without a scope hash still open code', (t) => {
  const root = approvedProject(t);
  put(root, '.phaseproof/approvals/phase-01.json', JSON.stringify({ phase: '01' }));
  put(root, 'phases/phase-01-auth/scope.md', '# changed\n');
  assert.equal(write(root, join(root, 'src/index.js')).allow, true);
});

test('bash cannot touch block records', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  assert.equal(bash(root, 'rm .phaseproof/blocks/phase-01.json').allow, false);
  assert.equal(bash(root, 'node /p/scripts/phaseproof.mjs block').allow, true);
});

test('bash cannot remove, move or link .phaseproof', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  for (const c of ['rm -rf .phaseproof', 'mv .phaseproof /tmp/x', 'cd .phaseproof && ln -s .. shell', 'rmdir .phaseproof/shell']) {
    assert.equal(bash(root, c).allow, false, c);
  }
  assert.equal(bash(root, 'cat .phaseproof/state.json').allow, true);
});
