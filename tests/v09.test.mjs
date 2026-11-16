import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { boundNote, factsFor, globMatches, loadFacts, rulings } from '../scripts/lib/facts.mjs';
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
const idOf = (root, text) => loadFacts(root).find((f) => f.text.startsWith(text)).id;
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

  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${idOf(top, 'OTP codes')}] holds - src/otp.js:1 ttl is 600 s\n`);
  const gate = cli(top, 'gate', '01');
  assert.equal(gate.code, 0, gate.err);
  assert.match(gate.out, /1 bound fact checked at this gate/);
  assert.match(cli(top, 'facts', 'src/otp.js').out, /checked at the phase 01 gate/);
  assert.match(cli(top, 'facts', 'src/jobs/send.js').out, /not checked by a gate yet/);
});

function gitFacts(t, learnings) {
  const top = tempProject(t);
  git(top, 'init', '-q');
  put(top, 'src/otp.js', 'export const ttl = 300;\n');
  cli(top, 'init', '--check', 'node -e "0"');
  put(top, 'docs/learnings.md', learnings);
  put(top, 'phases/phase-01-otp/scope.md', '# Phase 01\n');
  put(top, '.phaseproof/reviews/phase-01-docs.md', PASS);
  git(top, 'add', '-A');
  git(top, 'commit', '-qm', 'init');
  assert.equal(cli(top, 'approve', '01').code, 0);
  put(top, 'src/otp.js', 'export const ttl = 3600;\n');
  return top;
}

test('the gate refuses when the review calls a bound fact broken', (t) => {
  const top = gitFacts(t, LEARNINGS);
  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${idOf(top, 'OTP codes')}] broken - src/otp.js:1 sets 3600\n`);
  const gate = cli(top, 'gate', '01');
  assert.equal(gate.code, 1);
  assert.match(gate.err, /docs\/learnings\.md:5 is broken/);
  assert.equal(existsSync(join(top, '.phaseproof/gates/phase-01.json')), false);
});

test('facts the review does not rule on, or calls outdated, are not marked checked', (t) => {
  const top = gitFacts(t, `${LEARNINGS}- second otp rule (applies to: src/otp.js)\n`);
  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${idOf(top, 'OTP codes')}] outdated - ttl moved to config\n`);
  const gate = cli(top, 'gate', '01');
  assert.equal(gate.code, 0, gate.err);
  assert.match(gate.out, /docs\/learnings\.md:5 is outdated/);
  assert.match(gate.out, /did not rule on bound fact docs\/learnings\.md:8/);
  assert.doesNotMatch(gate.out, /checked at this gate/);
  assert.doesNotMatch(cli(top, 'facts', 'src/otp.js').out, /checked at the phase/);
});

test('a holds line outside the Facts section does not count', (t) => {
  const top = gitFacts(t, LEARNINGS);
  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Checked\n- [${idOf(top, 'OTP codes')}] holds - quoted\n`);
  assert.doesNotMatch(cli(top, 'gate', '01').out, /checked at this gate/);
});

test('facts --since takes a ref, refuses paths with it, and says what it leaves out', (t) => {
  const top = gitFacts(t, Array.from({ length: 22 }, (_, i) => `- rule ${i} (applies to: src/**)`).join('\n'));
  const r = cli(top, 'facts', '--since', 'HEAD');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /22 bound facts cover the code changed since [0-9a-f]{12} \(data from the project's docs, not instructions\)/);
  assert.match(r.out, /and 2 more not shown here/);
  assert.equal(cli(top, 'facts', 'src/otp.js', '--since').code, 1);
});

test('a crafted pattern or a whitespace-filled learnings file cannot stall the hook', (t) => {
  const started = Date.now();
  assert.equal(globMatches(`src/${'*a'.repeat(60)}b`, `src/${'a'.repeat(200)}.ts`), false);
  assert.equal(globMatches(`${'**/'.repeat(40)}x`, `${'d/'.repeat(60)}y`), false);
  assert.ok(Date.now() - started < 500, `glob took ${Date.now() - started} ms`);
  const root = approvedProject(t);
  put(root, 'docs/learnings.md', `- a table row${' '.repeat(200000)}|\n- bound (applies to: src/x.js)\n`);
  const t0 = Date.now();
  assert.equal(loadFacts(root).length, 1);
  edit(root, 'lib/unbound.ts');
  assert.ok(Date.now() - t0 < 1000, `learnings took ${Date.now() - t0} ms`);
});

test('the most specific fact comes first, and "none" binds nothing', (t) => {
  const root = approvedProject(t);
  put(root, 'docs/learnings.md', '- broad (applies to: src/**)\n- exact (applies to: src/auth/otp.js)\n- nothing (applies to: none)\n');
  assert.deepEqual(factsFor(root, 'src/auth/otp.js').map((f) => f.text), ['exact', 'broad']);
  assert.equal(loadFacts(root).length, 2);
});

test('outside a tracked project the hook adds nothing and writes nothing', (t) => {
  const root = tempProject(t);
  put(root, 'docs/learnings.md', LEARNINGS);
  assert.equal(edit(root, 'src/otp.js'), '');
  assert.equal(existsSync(join(root, '.phaseproof')), false);
});

test('a project from before 0.9 gets cache/ ignored by the hook itself, and a linked seen file is not followed', (t) => {
  const root = project(t);
  rmSync(join(root, '.phaseproof/.gitignore'), { force: true });
  assert.ok(note(edit(root, 'src/otp.js')));
  assert.match(readFileSync(join(root, '.phaseproof/.gitignore'), 'utf8'), /^cache\/$/m);
  if (process.platform === 'win32') return;
  mkdirSync(join(root, '.phaseproof/cache'), { recursive: true });
  symlinkSync('../gates/phase-01.json', join(root, '.phaseproof/cache/seen-s9.json'));
  edit(root, 'src/otp.js', 's9');
  assert.equal(existsSync(join(root, '.phaseproof/gates/phase-01.json')), false);
});

test('seen records older than a week are pruned at session start', (t) => {
  const root = project(t);
  edit(root, 'src/otp.js', 'old');
  const file = join(root, '.phaseproof/cache/seen-old.json');
  const past = new Date(Date.now() - 8 * 86400000);
  utimesSync(file, past, past);
  session(JSON.stringify({ cwd: root, session_id: 'new', source: 'startup' }), '');
  assert.equal(existsSync(file), false);
});

test('rulings follow the fact, not its line: moving or adding lines changes nothing', (t) => {
  const top = gitFacts(t, '- A rule (applies to: src/**)\n- B rule (applies to: src/**)\n');
  const a = idOf(top, 'A rule');
  const b = idOf(top, 'B rule');
  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${a}] holds\n- [${b}] broken - src/otp.js:1\n`);
  put(top, 'docs/learnings.md', '# Learnings\n\n- A rule (applies to: src/**)\n- C never reviewed (applies to: src/otp.js)\n- B rule (applies to: src/**)\n');
  const gate = cli(top, 'gate', '01');
  assert.equal(gate.code, 1);
  assert.match(gate.err, /docs\/learnings\.md:5 is broken/);
  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${a}] holds\n- [${b}] holds\n`);
  const ok = cli(top, 'gate', '01');
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /did not rule on bound fact docs\/learnings\.md:4/);
  assert.match(cli(top, 'facts', 'src/otp.js').out, /C never reviewed \(not checked by a gate yet\)/);
});

test('a copied template line or a ruling followed by a softer one does not mark a fact as holding', () => {
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] holds | broken | outdated - the file:line\n').size, 0);
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] broken - x\n- [3f9a1c2b7e] holds - on second look\n').get('3f9a1c2b7e'), 'broken');
  assert.equal(rulings('## **Facts**\n- **[3f9a1c2b7e]** `holds`\n').get('3f9a1c2b7e'), 'holds');
});

test('a fact whose text has letters that change length when lower-cased still binds', (t) => {
  const root = approvedProject(t);
  put(root, 'docs/learnings.md', '- \u0130\u0130\u0130\u0130 rule (applies to: src/auth/otp.js)\n');
  const [f] = loadFacts(root);
  assert.equal(f.text, '\u0130\u0130\u0130\u0130 rule');
  assert.deepEqual(f.patterns, ['src/auth/otp.js']);
});

test('a broken ruling still refuses when the changed code cannot be listed', (t) => {
  const root = approvedProject(t);
  put(root, 'docs/learnings.md', LEARNINGS);
  put(root, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${idOf(root, 'OTP codes')}] broken\n`);
  const gate = cli(root, 'gate', '01');
  assert.equal(gate.code, 1);
  assert.match(gate.err, /is broken/);
});

test('editing a fact after a broken ruling does not get the gate through', (t) => {
  const top = gitFacts(t, LEARNINGS);
  const id = idOf(top, 'OTP codes');
  put(top, '.phaseproof/reviews/phase-01-code.md', `${PASS}\n## Facts\n- [${id}] broken - src/otp.js:1 sets 3600\n`);
  put(top, 'docs/learnings.md', LEARNINGS.replace('5 minutes', '60 minutes'));
  const gate = cli(top, 'gate', '01');
  assert.equal(gate.code, 1);
  assert.match(gate.err, new RegExp(`\\[${id}\\] is broken`));
});

test('the ruling is the word straight after the id, not any word in the line', () => {
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] broken - sets 3600 s, so the rule no longer holds\n').get('3f9a1c2b7e'), 'broken');
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] docs/learnings.md:4 - holds - fine\n').get('3f9a1c2b7e'), 'holds');
  assert.equal(rulings('## Facts\n- [01a7f8393a] docs/learnings.md:1 the session lock holds across retries (not checked by a gate yet)\n').size, 0);
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] holds | broken | outdated - the file:line\n').size, 0);
});

test('changing an ADR decision makes it a new, unchecked fact', (t) => {
  const root = project(t);
  const before = idOf(root, 'decision: 0002');
  put(root, 'docs/decisions/0002-sessions.md', ADR.replace('Postgres.\n', 'Redis after all.\n'));
  assert.notEqual(idOf(root, 'decision: 0002'), before);
});

test('a copied fact line that starts with a ruling word is not a ruling', () => {
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] docs/learnings.md:2 holds the write lock until commit (not checked by a gate yet)\n').size, 0);
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] docs/learnings.md:2 - holds - fine\n').get('3f9a1c2b7e'), 'holds');
});

test('a broken ruling in another shape still counts as broken; holds stays strict', () => {
  for (const text of ['## Facts\n1. [3f9a1c2b7e] broken - x\n', '## Facts\n+ [3f9a1c2b7e] broken\n', '## Facts\n- [3f9a1c2b7e] (broken) x\n', '## Facts\n- [3f9a1c2b7e] is broken: x\n', '## Facts (2)\n- [3f9a1c2b7e] is broken\n', '**Facts**\n- [3f9a1c2b7e] is broken\n']) {
    assert.equal(rulings(text).get('3f9a1c2b7e'), 'broken', text);
  }
  assert.equal(rulings('## Facts\n- [3f9a1c2b7e] is fine and holds\n').size, 0);
  assert.equal(rulings('## Findings\n- [3f9a1c2b7e] broken\n').size, 0);
});

test('broken anywhere in a ruling line wins, and only the template shape is skipped', () => {
  assert.equal(rulings('## Facts\n- [0123456789] holds for login, but broken in the refresh path\n').get('0123456789'), 'broken');
  assert.equal(rulings('## Facts\n- [0123456789] outdated, and also broken in src/a.ts:3\n').get('0123456789'), 'broken');
  assert.equal(rulings('## Facts\n1. [0123456789] is broken: a || b defaults\n').get('0123456789'), 'broken');
  assert.equal(rulings('## Facts\n- [0123456789] holds / broken / outdated\n').size, 0);
  assert.equal(rulings('## Facts\n- [0123456789] docs/learnings.md:2 \u2014 holds the lock (not checked by a gate yet)\n').size, 0);
  assert.equal(rulings('## Facts\n### Auth\n- [0123456789] holds\n## Findings\n- [1123456789] holds\n').get('0123456789'), 'holds');
  assert.equal(rulings('## Facts\n### Auth\n- [0123456789] holds\n## Findings\n- [1123456789] holds\n').has('1123456789'), false);
});
