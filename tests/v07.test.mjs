import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { doctor } from '../scripts/lib/doctor.mjs';
import { historyFile, readHistory, recordHistory } from '../scripts/lib/history.mjs';
import { report } from '../scripts/lib/report.mjs';
import { respond as post } from '../scripts/post.mjs';
import { cli, FAIL, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const SCOPE = '# Phase 01\n\n**Goal:** g\n\n**Done when:** d\n';

function project(t, scope = SCOPE) {
  const root = tempProject(t);
  git(root, 'init', '-q');
  put(root, 'src/app.js', 'export const app = 1;\n');
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-auth/scope.md', scope);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}
const save = (root, kind, text) => post(JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: { file_path: put(root, `.phaseproof/reviews/phase-01-${kind}.md`, text) } }), root);
const levels = (found) => found.map((f) => `${f.level} ${f.text}`).join('\n');

test('saving a review appends one history line per distinct review', (t) => {
  const root = project(t);
  save(root, 'docs', PASS);
  save(root, 'docs', PASS);
  save(root, 'code', FAIL);
  save(root, 'code', `${PASS}\n`);
  const h = readHistory(root);
  assert.deepEqual(h.map((e) => `${e.kind} ${e.verdict} ${e.blockers}`), ['docs PASS 0', 'code FAIL 1', 'code PASS 0']);
  assert.equal(recordHistory(root, join(root, 'src/app.js')), false);
  assert.equal(recordHistory(tempProject(t), '.phaseproof/reviews/phase-01-code.md'), false);
  appendFileSync(historyFile(root), 'not json\n{"phase": 1}\n');
  assert.equal(readHistory(root).length, 3);
});

test('report shows each phase, its reviews and the blockers caught', (t) => {
  const root = project(t);
  save(root, 'docs', PASS);
  cli(root, 'approve');
  save(root, 'code', FAIL);
  save(root, 'code', 'VERDICT: FAIL\n- [blocker] a.js:1 x\n- [blocker] b.js:2 y\n');
  save(root, 'code', PASS);
  assert.equal(cli(root, 'gate').code, 0);
  cli(root, 'next');
  put(root, 'phases/phase-02-billing/scope.md', SCOPE);
  const r = report(root);
  assert.match(r, /^01 {5}auth {22}gate passed  3 reviews, 2 failed, 3 blocker findings; 0 gate warnings$/m);
  assert.match(r, /^02 {5}billing {19}planning {5}-$/m);
  assert.match(r, /1 phase closed\. 4 reviews recorded \(docs, design and code\), 2 failed, 3 blocker findings across them, 0 gate warnings\./);
  assert.match(r, /2 reviews failed before a gate/);
  assert.match(cli(root, 'report').out, /phaseproof report/);
});

test('report on a project with no history says when history starts', (t) => {
  const root = project(t);
  assert.match(report(root), /Review history is recorded from phaseproof 0\.7 on/);
  assert.match(cli(tempProject(t), 'report').err, /not tracked yet/);
});

test('doctor passes a healthy project and names what is missing', (t) => {
  const root = project(t);
  const plugin = tempProject(t);
  put(plugin, 'hooks/hooks.json', '{}');
  let found = doctor(root, { node: '22.1.0', pluginRoot: plugin });
  assert.equal(found.filter((f) => f.level === 'FAIL').length, 0, levels(found));
  assert.match(levels(found), /ok plugin hooks file found/);
  assert.match(levels(found), /ok gate runs 1 command/);
  found = doctor(root, { node: '18.19.0', pluginRoot: tempProject(t) });
  assert.match(levels(found), /FAIL Node 18\.19\.0 is too old/);
  assert.match(levels(found), /FAIL no hooks\/hooks\.json/);
  put(root, '.phaseproof/config.json', '{"checks": "npm test", "docPaths": 3}');
  found = levels(doctor(root, { node: '22.1.0' }));
  assert.match(found, /warn "checks" in \.phaseproof\/config\.json is not a list/);
  assert.match(found, /warn "docPaths" .* defaults are used/);
  assert.match(found, /FAIL no checks configured/);
  const r = cli(root, 'doctor');
  assert.equal(r.code, 1);
  assert.match(r.err, /problems? to fix/);
});

test('doctor flags scope gaps, bad locked tests, stale approvals and an ignored .phaseproof', (t) => {
  const root = project(t, '# Phase 01\n\n**Locked tests:** tests/missing.test.js\n');
  let found = levels(doctor(root, { node: '22.1.0' }));
  assert.match(found, /warn scope\.md of phase 01 has no \*\*Goal:\*\* line/);
  assert.match(found, /FAIL locked test tests\/missing\.test\.js does not exist yet/);
  put(root, 'phases/phase-01-auth/scope.md', SCOPE);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(root, 'approve');
  put(root, 'phases/phase-01-auth/scope.md', `${SCOPE}\nmore\n`);
  put(root, '.gitignore', '.phaseproof/\n');
  mkdirSync(join(root, 'phases/phase-01-extra'));
  found = levels(doctor(root, { node: '22.1.0' }));
  assert.match(found, /warn phase 01 changed since approval/);
  assert.match(found, /warn \.phaseproof\/ is gitignored/);
  assert.match(found, /FAIL phase 01 has 2 folders/);
});

test('doctor outside git, untracked, and with a lost base', (t) => {
  const plain = tempProject(t);
  assert.match(levels(doctor(plain, { node: '22.1.0' })), /warn this folder is not a git repository[\s\S]*warn this project is not tracked/);
  const root = project(t);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(root, 'approve');
  const a = join(root, '.phaseproof/approvals/phase-01.json');
  put(root, '.phaseproof/approvals/phase-01.json', JSON.stringify({ ...JSON.parse(readFileSync(a, 'utf8')), base: 'b'.repeat(40) }));
  assert.match(levels(doctor(root, { node: '22.1.0' })), /approval's base commit bbbbbbbbbbbb is gone/);
});

test('reviews and folders with phase numbers phaseproof would not use stay out of the report', (t) => {
  const root = project(t);
  post(JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: { file_path: put(root, '.phaseproof/reviews/phase-1-code.md', FAIL) } }), root);
  post(JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: { file_path: put(root, '.phaseproof/reviews/phase-001-code.md', FAIL) } }), root);
  assert.deepEqual(readHistory(root).map((e) => e.phase), ['001']);
  put(root, 'phases/phase-02.md', 'notes');
  mkdirSync(join(root, 'phases/phase-3-odd'));
  const r = report(root);
  assert.doesNotMatch(r, /^(1|02|3) {2,}/m);
});

test('a cut-off last history line does not swallow the next entry', (t) => {
  const root = project(t);
  save(root, 'docs', PASS);
  appendFileSync(historyFile(root), '{"phase":"01","kind":"co');
  save(root, 'code', FAIL);
  assert.deepEqual(readHistory(root).map((e) => e.kind), ['docs', 'code']);
});

test('doctor accepts a Done when list, checks its own hooks file, and names a broken config', (t) => {
  const root = project(t, '# Phase 01\n\n**Goal:** g\n\n**Done when:**\n1. a\n2. b\n');
  let found = levels(doctor(root, { node: '22.1.0' }));
  assert.doesNotMatch(found, /no \*\*Done when:\*\* line/);
  assert.match(found, /ok plugin hooks file found/);
  put(root, '.phaseproof/config.json', '{"checks": ["npm test"],}');
  found = levels(doctor(root, { node: '22.1.0' }));
  assert.match(found, /FAIL \.phaseproof\/config\.json cannot be read as JSON/);
  const r = cli(project(t), 'doctor');
  assert.equal(r.code, 0, r.err);
});

test('doctor survives a phases file and reports a block and a changed config', (t) => {
  const plainPhases = tempProject(t);
  git(plainPhases, 'init', '-q');
  cli(plainPhases, 'init', '--check', 'node -e "0"');
  put(plainPhases, 'phases', 'not a folder');
  assert.match(levels(doctor(plainPhases, { node: '22.1.0' })), /warn no phases\/ folder yet/);
  const root = project(t);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  cli(root, 'approve');
  put(root, '.phaseproof/reviews/phase-01-code.md', FAIL);
  cli(root, 'block');
  put(root, '.phaseproof/config.json', '{"checks": ["true"]}');
  const found = levels(doctor(root, { node: '22.1.0' }));
  assert.match(found, /warn phase 01 is blocked/);
  assert.match(found, /warn the checks or doc paths changed since phase 01 was approved/);
});

test('three-digit phases are recorded and reported; a dangling link or file in phases/ drops nothing', (t) => {
  const root = tempProject(t);
  git(root, 'init', '-q');
  cli(root, 'init', '--check', 'node -e "0"', '--phase', '100');
  put(root, 'phases/phase-100-big/scope.md', SCOPE);
  post(JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: { file_path: put(root, '.phaseproof/reviews/phase-100-docs.md', PASS) } }), root);
  assert.equal(readHistory(root).length, 1);
  put(root, 'phases/phase-101', 'a file, not a folder');
  put(root, 'phases/phase-103-c/scope.md', SCOPE);
  if (process.platform !== 'win32') symlinkSync(join(root, 'nowhere'), join(root, 'phases/phase-102-gone'));
  const r = report(root);
  assert.match(r, /^100 {4}big/m);
  assert.match(r, /^103 {4}c /m);
  assert.doesNotMatch(r, /^101 /m);
});

test('doctor flags an empty Goal', (t) => {
  const root = project(t, '# Phase 01\n\n**Goal:**\n\n**Done when:** d\n');
  assert.match(levels(doctor(root, { node: '22.1.0' })), /warn \*\*Goal:\*\* in scope\.md of phase 01 is empty/);
});
