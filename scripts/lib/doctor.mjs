import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { lockIssues } from './locks.mjs';
import {
  approvalFile,
  blockFile,
  configChanged,
  gateRuns,
  isActive,
  loadConfig,
  loadState,
  phaseDirs,
  ppPath,
  readJson,
  scopeChanged,
  scopeField,
  scopeList,
  scopeText,
} from './project.mjs';

const git = (root, args) => spawnSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 * 1024 });
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const MANY_UNTRACKED = 500;
const OWN_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function parses(file) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return true;
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

export function doctor(root, { node = process.versions.node, pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || OWN_ROOT } = {}) {
  const out = [];
  const ok = (text) => out.push({ level: 'ok', text });
  const warn = (text) => out.push({ level: 'warn', text });
  const fail = (text) => out.push({ level: 'FAIL', text });

  const major = Number(String(node).split('.')[0]);
  if (major >= 20) ok(`Node ${node}`);
  else fail(`Node ${node} is too old. phaseproof needs Node 20 or later on PATH`);

  if (existsSync(join(pluginRoot, 'hooks', 'hooks.json'))) ok('plugin hooks file found');
  else fail(`no hooks/hooks.json under ${pluginRoot}. Reinstall the plugin`);

  const version = git(root, ['--version']);
  const inGit = version.status === 0 && git(root, ['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';
  if (version.status !== 0) warn('git was not found. The shell guard, test guard, review record and budget need it');
  else if (!inGit) warn('this folder is not a git repository. The shell guard, test guard, review record and budget need one');
  else if (git(root, ['rev-parse', '-q', '--verify', 'HEAD']).status !== 0) warn('the repository has no commits yet. Commit once so approvals have a base to compare against');
  else ok('git repository with history');

  if (!isActive(root)) {
    warn('this project is not tracked. Run /phaseproof:kickoff');
    return out;
  }
  const phase = loadState(root)?.phase;
  if (typeof phase !== 'string' || !/^\d{1,3}$/.test(phase)) {
    fail('.phaseproof/state.json has no valid phase number');
    return out;
  }
  ok(`tracking phase ${phase}`);

  if (!parses(ppPath(root, 'config.json'))) fail('.phaseproof/config.json cannot be read as JSON (a trailing comma, or not a file), so its checks and doc paths are ignored');
  const raw = readJson(ppPath(root, 'config.json'), {}) ?? {};
  if (raw.checks !== undefined && !strings(raw.checks)) warn('"checks" in .phaseproof/config.json is not a list of commands, so it is ignored');
  if (raw.docPaths !== undefined && !strings(raw.docPaths)) warn('"docPaths" in .phaseproof/config.json is not a list of paths, so the defaults are used');
  const { checks } = loadConfig(root);
  const runs = gateRuns(root, phase);
  if (!checks.length && !runs.length) fail('no checks configured and no **Gate runs:** in the scope, so the gate cannot pass. Add your test commands to "checks" in .phaseproof/config.json');
  else ok(`gate runs ${checks.length + runs.length} command${checks.length + runs.length === 1 ? '' : 's'}`);

  const dirs = phaseDirs(root, phase);
  if (dirs.length > 1) fail(`phase ${phase} has ${dirs.length} folders. Keep one`);
  else if (!dirs.length) warn(`phase ${phase} has no folder yet. Plan it with /phaseproof:phase ${phase} <name>`);
  else {
    const scope = scopeText(root, phase);
    if (!scope) warn(`phase ${phase} has no scope.md yet`);
    else {
      for (const field of ['Goal', 'Done when']) {
        const value = scopeField(scope, field);
        if (value === null) warn(`scope.md of phase ${phase} has no **${field}:** line`);
        else if (!value && !scopeList(scope, field).length) warn(`**${field}:** in scope.md of phase ${phase} is empty`);
      }
    }
  }

  const approved = existsSync(approvalFile(root, phase));
  for (const issue of lockIssues(root, phase)) (approved ? warn : fail)(issue);
  if (approved) {
    if (scopeChanged(root, phase)) warn(`phase ${phase} changed since approval, so code is closed until the owner approves again`);
    if (configChanged(root, phase)) warn(`the checks or doc paths changed since phase ${phase} was approved, so code is closed until the owner approves again`);
    const approval = readJson(approvalFile(root, phase), {}) ?? {};
    const base = approval.base ?? approval.head;
    if (inGit && typeof base === 'string' && git(root, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) {
      warn(`the approval's base commit ${base.slice(0, 12)} is gone (rebase or gc). /phaseproof:approve ${phase} --new-base records a new one`);
    }
  }
  if (existsSync(blockFile(root, phase))) warn(`phase ${phase} is blocked after two failed code reviews and waits on the owner`);

  if (inGit) {
    if (git(root, ['check-ignore', '-q', '--no-index', '.phaseproof/approvals/phase-00.json']).status === 0) warn('.phaseproof/ is gitignored. Commit it: approvals and gates are the audit trail');
    const others = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
    const count = others.status === 0 ? others.stdout.split('\0').filter(Boolean).length : 0;
    if (count > MANY_UNTRACKED) warn(`${count} untracked files are not gitignored. Ignore build and test output; it slows the review record and shows up as gate warnings`);
  }

  const phasesDir = join(root, 'phases');
  let isFolder = false;
  try {
    isFolder = statSync(phasesDir).isDirectory() && readdirSync(phasesDir).length > 0;
  } catch {
    isFolder = false;
  }
  if (!isFolder) warn('no phases/ folder yet. /phaseproof:kickoff writes it');
  return out;
}
