import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from '../scripts/hook.mjs';
import { cli, tempProject } from './helpers.mjs';

const HOOK = fileURLToPath(new URL('../scripts/hook.mjs', import.meta.url));
const input = (root, file) => JSON.stringify({ cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } });

test('fails open on garbage input', () => {
  assert.equal(respond('not json'), '');
  assert.equal(respond(''), '');
});

test('silent when allowed', (t) => {
  const root = tempProject(t);
  assert.equal(respond(input(root, join(root, 'src/a.js')), {}), '');
});

test('emits a deny decision for blocked code', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  const out = JSON.parse(respond(input(root, join(root, 'src/a.js')), {}));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^phaseproof: phase 01/);
});

test('CLAUDE_PROJECT_DIR wins over cwd', (t) => {
  const root = tempProject(t);
  const other = tempProject(t);
  cli(root, 'init');
  const raw = JSON.stringify({ cwd: other, tool_name: 'Write', tool_input: { file_path: join(root, 'src/a.js') } });
  assert.notEqual(respond(raw, { CLAUDE_PROJECT_DIR: root }), '');
});

test('runs as a process over stdin', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  const r = spawnSync(process.execPath, [HOOK], { input: input(root, join(root, 'src/a.js')), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});
