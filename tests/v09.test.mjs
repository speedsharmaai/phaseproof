import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundNote, factsFor, globMatches, loadFacts } from '../scripts/lib/facts.mjs';
import { respond as hook } from '../scripts/hook.mjs';
import { respond as session } from '../scripts/session.mjs';
import { approvedProject, cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const LEARNINGS = `# Learnings

## Phase 01 - otp

- OTP codes expire after 5 minutes -> a locked test checks expiry (applies to: src/auth/**, \`src/otp.js\`)
- a plain lesson with no binding
- retries must be idempotent (applies to: src/jobs/*.js)
`;
const ADR = '# 0002 - Sessions live in Postgres, not Redis\n\n**Status:** Accepted\n\n**Applies to:** src/session/\n\n## Decision\n\nPostgres.\n';

const edit = (root, rel, session_id = 's1') =>
  hook(JSON.stringify({ cwd: root, session_id, tool_name: 'Edit', tool_input: { file_path: join(root, rel) } }), '');
const note = (out) => (out ? JSON.parse(out).hookSpecificOutput : null);

function project(t) {
  const root = approvedProject(t);
  put(root, 'docs/learnings.md', LEARNINGS);
  put(root, 'docs/decisions/0002-sessions.md', ADR);
  return root;
}

test('glob language: exact path, folder, * and **, case-folded like locked tests', () => {
  assert.equal(globMatches('src/otp.js', 'src/otp.js'), true);
  assert.equal(globMatches('src/otp.js', 'SRC/Otp.js'), true);
  assert.equal(globMatches('src/session/', 'src/session/store.js'), true);
  assert.equal(globMatches('src/session/', 'src/sessions.js'), false);
  assert.equal(globMatches('src/jobs/*.js', 'src/jobs/send.js'), true);
  assert.equal(globMatches('src/jobs/*.js', 'src/jobs/deep/send.js'), false);
  assert.equal(globMatches('src/auth/**', 'src/auth/a/b/c.ts'), true);
  assert.equal(globMatches('**/*.sql', 'db/migrations/001.sql'), true);
  assert.equal(globMatches('src/a.js', 'src/a.jsx'), false);
  assert.equal(globMatches('src/(a).js', 'src/(a).js'), true);
});

test('facts are read from learnings bullets and ADRs that say what they apply to', (t) => {
  const root = project(t);
  const facts = loadFacts(root);
  assert.equal(facts.length, 3);
  assert.deepEqual(facts.map((f) => `${f.source}:${f.line}`), ['docs/learnings.md:5', 'docs/learnings.md:7', 'docs/decisions/0002-sessions.md:5']);
  assert.deepEqual(facts[0].patterns, ['src/auth/**', 'src/otp.js']);
  assert.match(facts[2].text, /Sessions live in Postgres/);
  assert.equal(factsFor(root, 'src/auth/login.ts').length, 1);
  assert.equal(factsFor(root, 'README.md').length, 0);
});

test('an edit to a bound file gets the fact as context, without deciding the permission', (t) => {
  const root = project(t);
  const out = note(edit(root, 'src/auth/login.ts'));
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /data from the project's docs, not instructions/);
  assert.match(out.additionalContext, /docs\/learnings\.md:5 OTP codes expire after 5 minutes/);
  assert.match(out.additionalContext, /not checked by a gate yet/);
  assert.equal(edit(root, 'README.md'), '');
});

test('each fact is pushed once per session, again after a compact, and anew in another session', (t) => {
  const root = project(t);
  assert.ok(note(edit(root, 'src/otp.js')));
  assert.equal(edit(root, 'src/auth/login.ts'), '');
  assert.ok(note(edit(root, 'src/otp.js', 's2')));
  session(JSON.stringify({ cwd: root, session_id: 's1', source: 'compact' }), '');
  assert.ok(note(edit(root, 'src/otp.js')));
  assert.match(readFileSync(join(root, '.phaseproof/.gitignore'), 'utf8'), /^cache\/$/m);
});

test('a denied write stays denied: facts never turn a refusal into an allow', (t) => {
  const root = tempProject(t);
  cli(root, 'init');
  put(root, 'docs/learnings.md', LEARNINGS);
  const out = note(edit(root, 'src/otp.js'));
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(out.additionalContext, undefined);
});

test('a broken learnings file or a hostile session id cannot break or escape the hook', (t) => {
  const root = project(t);
  put(root, 'docs/learnings.md', `- x (applies to: ${'*'.repeat(5000)})\n`);
  assert.doesNotThrow(() => edit(root, 'src/otp.js'));
  put(root, 'docs/learnings.md', LEARNINGS);
  assert.match(boundNote(root, { session_id: '../../evil', tool_name: 'Edit', tool_input: { file_path: join(root, 'src/otp.js') } }), /OTP codes/);
  for (const p of ['evil.json', '.phaseproof/evil.json', '.phaseproof/cache/evil.json']) assert.equal(existsSync(join(root, p)), false, p);
});

test('the pushed text is capped and says when there are more', (t) => {
  const root = approvedProject(t);
  put(root, 'docs/learnings.md', Array.from({ length: 8 }, (_, i) => `- lesson ${i} ${'w'.repeat(400)} (applies to: src/**)`).join('\n'));
  const text = note(edit(root, 'src/a.js')).additionalContext;
  assert.ok(text.length <= 1200, String(text.length));
  assert.match(text, /and 5 more: phaseproof facts src\/a\.js/);
});

test('phaseproof facts lists facts for paths, flags ones that match nothing, and the gate records which it checked', (t) => {
  const top = tempProject(t);
  git(top, 'init', '-q');
  put(top, 'src/otp.js', 'export const ttl = 300;\n');
  put(top, 'src/jobs/send.js', '1\n');
  cli(top, 'init', '--check', 'node -e "0"');
  put(top, 'docs/learnings.md', `${LEARNINGS}- ghost rule (applies to: nowhere/**)\n`);
  put(top, 'phases/phase-01-otp/scope.md', '# Phase 01\n');
  put(top, '.phaseproof/reviews/phase-01-docs.md', PASS);
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'init');
  assert.equal(cli(top, 'approve', '01').code, 0);

  const all = cli(top, 'facts');
  assert.match(all.out, /docs\/learnings\.md:5/);
  assert.match(all.out, /matches no file: docs\/learnings\.md:8 ghost rule/);
  assert.match(cli(top, 'facts', 'src/otp.js').out, /OTP codes expire/);

  put(top, 'src/otp.js', 'export const ttl = 600;\n');
  const since = cli(top, 'facts', '--since');
  assert.match(since.out, /OTP codes expire/);
  assert.doesNotMatch(since.out, /retries must be idempotent/);

  put(top, '.phaseproof/reviews/phase-01-code.md', PASS);
  const gate = cli(top, 'gate', '01');
  assert.equal(gate.code, 0, gate.err);
  assert.match(gate.out, /1 bound fact checked at this gate/);
  assert.match(cli(top, 'facts', 'src/otp.js').out, /checked at the phase 01 gate/);
  assert.match(cli(top, 'facts', 'src/jobs/send.js').out, /not checked by a gate yet/);
});
