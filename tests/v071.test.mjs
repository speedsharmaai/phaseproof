import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '../scripts/lib/decide.mjs';
import { runChecks } from '../scripts/lib/checks.mjs';
import { doctor } from '../scripts/lib/doctor.mjs';
import { approvalFile, findRoot, readJson, scopeHash, sha256, writeJson } from '../scripts/lib/project.mjs';
import { parseVerdict } from '../scripts/lib/verdict.mjs';
import { respond as hook } from '../scripts/hook.mjs';
import { approvedProject, cli, PASS, put, tempProject } from './helpers.mjs';

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
const write = (root, rel) => decide({ root, toolName: 'Write', toolInput: { file_path: join(root, rel) } });
const bash = (root, command) => decide({ root, toolName: 'Bash', toolInput: { command } });
const TASKS = '# Tasks\n\n## 1. Model\n- [ ] add the otp table\n- [ ] expire codes after 5 minutes\n\n**Check:** node --test\n';

function withTasks(t, tasks = TASKS) {
  const root = tempProject(t);
  cli(root, 'init', '--check', 'node -e "process.exit(0)"');
  put(root, 'phases/phase-01-otp/scope.md', '# Phase 01\n');
  put(root, 'phases/phase-01-otp/tasks.md', tasks);
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  assert.equal(cli(root, 'approve', '01').code, 0);
  return root;
}

test('ticking a task box keeps code open and the approval fresh', (t) => {
  const root = withTasks(t);
  put(root, 'phases/phase-01-otp/tasks.md', TASKS.replace('- [ ] add', '- [x] add').replace('- [ ] expire', '- [X] expire'));
  assert.equal(write(root, 'src/otp.js').allow, true);
  assert.match(cli(root, 'status').out, /approved {5}yes/);
});

test('a checkout that turns line endings into CRLF keeps the approval fresh', (t) => {
  const root = withTasks(t);
  put(root, 'phases/phase-01-otp/tasks.md', TASKS.replace(/\n/g, '\r\n'));
  assert.equal(write(root, 'src/otp.js').allow, true);
});

test('editing task text still closes code', (t) => {
  const root = withTasks(t);
  put(root, 'phases/phase-01-otp/tasks.md', TASKS.replace('5 minutes', '50 minutes'));
  assert.match(write(root, 'src/otp.js').reason, /scope changed after it was approved/);
});

test('ticking a box in scope.md is a scope change', (t) => {
  const root = withTasks(t);
  put(root, 'phases/phase-01-otp/scope.md', '# Phase 01\n\n- [ ] billing\n');
  put(root, '.phaseproof/reviews/phase-01-docs.md', `${PASS}\nwith billing line\n`);
  assert.equal(cli(root, 'approve', '01').code, 0);
  put(root, 'phases/phase-01-otp/scope.md', '# Phase 01\n\n- [x] billing\n');
  assert.equal(write(root, 'src/otp.js').allow, false);
});

test('a box only counts when it sits on its list item line', (t) => {
  const root = withTasks(t, `${TASKS}\n-\n[ ] = exported row\n`);
  put(root, 'phases/phase-01-otp/tasks.md', `${TASKS}\n-\n[x] = exported row\n`);
  assert.equal(write(root, 'src/otp.js').allow, false);
});

test('only a list-item checkbox is folded, not [x] elsewhere in the text', (t) => {
  const root = withTasks(t, `${TASKS}\nKeep the [ ] marker in the CSV export.\n`);
  put(root, 'phases/phase-01-otp/tasks.md', `${TASKS}\nKeep the [x] marker in the CSV export.\n`);
  assert.equal(write(root, 'src/otp.js').allow, false);
});

test('an approval made by 0.7.0 on ticked boxes stays valid', (t) => {
  const ticked = TASKS.replace('- [ ] add', '- [x] add');
  const root = withTasks(t, ticked);
  const dir = join(root, 'phases/phase-01-otp');
  const raw = sha256(['scope.md', 'tasks.md', 'screens.md'].map((n) => `${n}\n${existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : ''}`).join('\n---\n'));
  writeJson(approvalFile(root, '01'), { ...readJson(approvalFile(root, '01')), scopeHash: raw });
  assert.notEqual(raw, scopeHash(root, '01'));
  assert.equal(write(root, 'src/otp.js').allow, true);
  const again = cli(root, 'approve', '01');
  assert.equal(again.code, 0, again.err);
});

test('re-approving an untouched 0.7.0 phase with CRLF docs is not refused', (t) => {
  const root = withTasks(t, TASKS.replace(/\n/g, '\r\n'));
  const dir = join(root, 'phases/phase-01-otp');
  const raw = sha256(['scope.md', 'tasks.md', 'screens.md'].map((n) => `${n}\n${existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : ''}`).join('\n---\n'));
  writeJson(approvalFile(root, '01'), { ...readJson(approvalFile(root, '01')), scopeHash: raw });
  const r = cli(root, 'approve', '01');
  assert.equal(r.code, 0, r.err);
});

test('the CLI finds the project from a subfolder, the same root the hook uses', (t) => {
  const root = approvedProject(t);
  const sub = join(root, 'packages', 'web');
  put(sub, 'index.js');
  assert.equal(findRoot(sub), root);
  assert.equal(findRoot(root), root);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'phaseproof.mjs'), 'status'], { cwd: sub, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /phase 01/);
  const viaHook = JSON.parse(hook(JSON.stringify({ cwd: sub, tool_name: 'Write', tool_input: { file_path: join(root, '.phaseproof/approvals/phase-01.json') } }), ''));
  assert.equal(viaHook.hookSpecificOutput.permissionDecision, 'deny');
});

test('init from a subfolder of a tracked project refuses through the real CLI too', (t) => {
  const root = approvedProject(t);
  const sub = join(root, 'packages', 'web');
  put(sub, 'index.js');
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'phaseproof.mjs'), 'init'], { cwd: sub, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already tracked at/);
  assert.equal(existsSync(join(sub, '.phaseproof')), false);
});

test('init inside a tracked project refuses instead of nesting', (t) => {
  const root = approvedProject(t);
  const sub = join(root, 'phases');
  const r = cli(sub, 'init');
  assert.equal(r.code, 1);
  assert.match(r.err, /already tracked/);
  assert.equal(existsSync(join(sub, '.phaseproof')), false);
});

test('.phaseproof records are protected under any spelling the file system folds to it', (t) => {
  const root = approvedProject(t);
  const spellings = ['.PhaseProof/approvals/phase-02.json', '.PHASEPROOF/state.json', '.Phaseproof/gates/phase-01.json', '.pha\u017Feproof/gates/phase-01.json', '.phaseproof./approvals/phase-01.json', '.phaseproof /state.json', 'PHASEP~1/gates/phase-01.json'];
  for (const rel of spellings) assert.equal(write(root, rel).allow, false, rel);
  assert.equal(write(root, '.phaseproof/reviews/phase-01-code.md').allow, true);
  assert.equal(write(root, '.PhaseProof/reviews/phase-01-code.md').allow, false);
  for (const cmd of ['echo {} > .PhaseProof/approvals/phase-01.json', 'echo {} > .pha\u017Feproof/gates/phase-01.json', 'echo {} > .phaseproof./gates/phase-01.json', 'node scripts/PHASEPROOF.mjs approve 01']) {
    assert.equal(bash(root, cmd).allow, false, cmd);
  }
});

test('a failing check prints its output, not only its name', (t) => {
  const root = approvedProject(t, ['node -e "console.error(\'expected \' + 3 + \' got \' + 4 + \' at sum.test.js:7\'); process.exit(1)"']);
  const r = cli(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.out, /\n {6}expected 3 got 4 at sum\.test\.js:7/);
});

test('a passing check stays one line', (t) => {
  const root = approvedProject(t, ['node -e "console.log(\'lots of \' + \'noise\')"']);
  const { out } = cli(root, 'check');
  assert.equal(out.split('\n').length, 1);
  assert.doesNotMatch(out, /lots of noise/);
});

test('a check that hangs is stopped and reported, with what it started', (t) => {
  const root = tempProject(t);
  const pidFile = join(root, 'pid');
  const [r] = runChecks(root, [`node -e "require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 60000)"; echo done`], 1500);
  assert.notEqual(r.code, 0);
  assert.match(r.tail, /timed out after/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('an unreadable state.json is a clear refusal that points at doctor', (t) => {
  for (const bad of ['{bad', '', 'null', '{"phase":1}']) {
    const root = tempProject(t);
    cli(root, 'init');
    put(root, '.phaseproof/state.json', bad);
    for (const cmd of ['status', 'approve', 'check', 'gate', 'next', 'block', 'report']) {
      const r = cli(root, cmd);
      assert.equal(r.code, 1, `${cmd} on ${JSON.stringify(bad)}`);
      assert.match(r.err, /state\.json.*doctor/, `${cmd} on ${JSON.stringify(bad)}`);
    }
    assert.match(write(root, 'src/a.js').reason, /doctor/);
  }
});

test('approve warns when there is no git history to compare against', (t) => {
  const root = tempProject(t);
  cli(root, 'init', '--check', 'node -e "0"');
  put(root, 'phases/phase-01-otp/scope.md', '# Phase 01\n');
  put(root, '.phaseproof/reviews/phase-01-docs.md', PASS);
  assert.match(cli(root, 'approve', '01').out, /not a git repository.*git init/);
  git(root, 'init', '-q');
  assert.match(cli(root, 'approve', '01').out, /no commits yet/);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  assert.doesNotMatch(cli(root, 'approve', '01').out, /git init|no commits/);
  assert.notEqual(readJson(approvalFile(root, '01')).base, null);
});

test('verdict: markdown bold and code around the line still count', () => {
  assert.equal(parseVerdict('**VERDICT:** PASS\n').pass, true);
  assert.equal(parseVerdict('**VERDICT: FAIL**\n').reason, 'verdict is FAIL');
  assert.equal(parseVerdict('`VERDICT: PASS`\n').pass, true);
});

test('verdict: any FAIL line wins over a quoted PASS', () => {
  assert.equal(parseVerdict('VERDICT: FAIL | 2 majors\n\n## Checked\n- cat docs review:\nVERDICT: PASS\n').pass, false);
  assert.equal(parseVerdict('`VERDICT: PASS` once the retry bug is fixed.\nVERDICT: FAIL\n').pass, false);
  assert.equal(parseVerdict('**VERDICT: PASS** would need the migration test.\nVERDICT: FAIL\n').pass, false);
});

test('verdict: the template line is not a verdict', () => {
  assert.equal(parseVerdict('VERDICT: PASS | FAIL\n').reason, 'no VERDICT line');
  assert.equal(parseVerdict('Answer with VERDICT: PASS | FAIL\n\nVERDICT: FAIL\n').reason, 'verdict is FAIL');
});

test('verdict: numbered and bold blockers are counted', () => {
  assert.match(parseVerdict('VERDICT: PASS\n1. [blocker] a.js:1 crash\n').reason, /1 open blocker/);
  assert.match(parseVerdict('VERDICT: PASS\n- **[blocker]** a.js:1 crash\n').reason, /1 open blocker/);
});

test('init sets a union merge for the review history inside .phaseproof only', (t) => {
  const root = tempProject(t);
  git(root, 'init', '-q');
  cli(root, 'init');
  assert.equal(existsSync(join(root, '.gitattributes')), false);
  const r = git(root, 'check-attr', 'merge', '--', '.phaseproof/runs/reviews.jsonl');
  assert.match(r.stdout, /merge: union/);
  assert.equal(write(root, '.phaseproof/.gitattributes').allow, false);
});

test('session context is re-injected on fork as well', () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].matcher, /\bfork\b/);
});

test('doctor warns when a setting forces every subagent onto one model', (t) => {
  const root = approvedProject(t);
  const warned = (env) => doctor(root, { node: '22.1.0', env }).some((f) => f.level === 'warn' && /MODEL_FORCE/.test(f.text));
  assert.equal(warned({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }), true);
  assert.equal(warned({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0' }), false);
  assert.equal(warned({}), false);
});
