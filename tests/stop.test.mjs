import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, runFile } from '../scripts/lib/project.mjs';
import { respond } from '../scripts/stop.mjs';
import { cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });

function project(t) {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'src/app.js', 'export const app = 1;\n');
  cli(root, 'init', '--check', 'node -e "process.exit(require(\'fs\').readFileSync(\'src/app.js\',\'utf8\').includes(\'2\') ? 0 : 1)"');
  put(root, 'phases/phase-01-x/scope.md', '# Phase 01\n\n**Goal:** g\n\n**Done when:** d\n');
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  cli(root, 'approve');
  return root;
}

const stop = (root, extra = {}) => respond(JSON.stringify({ cwd: root, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], ...extra }), root);

test('stopping with red checks and no change since asks once to fix or explain', (t) => {
  const root = project(t);
  assert.equal(cli(root, 'check').code, 1);
  assert.ok(readJson(runFile(root, '01')).fingerprint);
  const out = JSON.parse(stop(root));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /last check run for phase 01 failed \(node -e/);
  assert.match(out.reason, /tell the owner plainly that the checks are red/);
  assert.equal(stop(root, { stop_hook_active: true }), '');
  assert.equal(stop(root), '');
  cli(root, 'check');
  assert.equal(JSON.parse(stop(root)).decision, 'block');
});

test('no nudge once code changed, checks are green, work runs in the background, or the phase is not building', (t) => {
  const root = project(t);
  assert.equal(stop(root), '');
  cli(root, 'check');
  put(root, 'src/app.js', 'export const app = 3;\n');
  assert.equal(stop(root), '');
  put(root, 'src/app.js', 'export const app = 2;\n');
  assert.equal(cli(root, 'check').code, 0);
  assert.equal(stop(root), '');
  put(root, 'src/app.js', 'export const app = 1;\n');
  cli(root, 'check');
  assert.equal(stop(root, { background_tasks: [{ id: 'b1' }] }), '');
  put(root, '.phaseproof/reviews/phase-01-code.md', 'VERDICT: FAIL\n- [blocker] src/app.js:1 x\n');
  cli(root, 'block');
  assert.equal(stop(root), '');
});

test('the Stop hook stays silent outside phaseproof, on junk, and on damaged run records', (t) => {
  assert.equal(stop(tempProject(t)), '');
  assert.equal(respond('nope', ''), '');
  const root = project(t);
  cli(root, 'check');
  writeFileSync(join(root, '.phaseproof/runs/phase-01-checks.json'), '{"results": "x"}');
  assert.equal(stop(root), '');
  writeFileSync(join(root, '.phaseproof/runs/phase-01-checks.json'), '{"results": [{"code": 1, "cmd": "t"}], "fingerprint": {"tracked": 1}}');
  assert.equal(stop(root), '');
});

test('no nudge before approval, after the gate, while code is closed, or once a new file appeared', (t) => {
  const root = project(t);
  cli(root, 'check');
  put(root, 'src/extra.js', 'x\n');
  assert.equal(stop(root), '');
  const fresh = project(t);
  cli(fresh, 'check');
  put(fresh, 'phases/phase-01-x/scope.md', '# Phase 01\n\n**Goal:** changed\n');
  assert.equal(stop(fresh), '');
  const gated = project(t);
  put(gated, 'src/app.js', 'export const app = 2;\n');
  put(gated, '.phaseproof/reviews/phase-01-code.md', PASS);
  assert.equal(cli(gated, 'gate').code, 0);
  put(gated, 'src/app.js', 'export const app = 1;\n');
  cli(gated, 'check');
  assert.equal(stop(gated), '');
  const unapproved = tempProject(t);
  git(unapproved, 'init', '-q');
  cli(unapproved, 'init', '--check', 'node -e "process.exit(1)"');
  cli(unapproved, 'check');
  assert.equal(stop(unapproved), '');
});
