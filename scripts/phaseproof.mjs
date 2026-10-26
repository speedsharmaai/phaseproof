import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { measure, overBudget } from './lib/budget.mjs';
import { allPassed, runChecks } from './lib/checks.mjs';
import { codeFingerprint, reviewDrift } from './lib/drift.mjs';
import { isMain } from './lib/main.mjs';
import {
  approvalFile,
  blockFile,
  changedLocked,
  DEFAULT_CONFIG,
  configChanged,
  configHash,
  gateFile,
  gitHead,
  exactCase,
  gateRuns,
  isActive,
  linkedPath,
  loadConfig,
  loadState,
  lockedDigests,
  lockedTests,
  padPhase,
  phaseDir,
  phaseDirs,
  ppPath,
  readJson,
  readText,
  reviewFile,
  runFile,
  scopeChanged,
  scopeBudget,
  scopeHash,
  scopeList,
  scopeText,
  sha256,
  toProjectPath,
  writeJson,
} from './lib/project.mjs';
import { parseVerdict } from './lib/verdict.mjs';
import { usableDocPath } from './lib/decide.mjs';
import { isTestFile, testTampering } from './lib/tests-guard.mjs';

const USAGE = `usage: phaseproof <command>

  init [--check "<cmd>"]... [--phase NN]
                              start tracking this project (checks run before every gate)
  status                      current phase and what it is waiting on
  approve <phase> [--quick] [--new-base]
                              owner sign-off that opens code for a phase (also clears a block)
  check [phase]               run the configured checks and record the result
  gate <phase>                re-run checks, read the code review, close the phase
  block [phase]               stop the phase after a failed code review until the owner decides
  next                        move to the next phase once the gate has passed`;

class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

function requireOneFolder(root, phase) {
  const dirs = phaseDirs(root, phase);
  if (dirs.length > 1) refuse(`phase ${phase} has ${dirs.length} folders (${dirs.map((d) => d.split(/[\\/]/).pop()).join(', ')}). Keep one; a quick fix waits for the current phase or goes into its scope.`);
  return dirs[0] ?? null;
}

const removalAllowance = (root, phase) => scopeList(scopeText(root, phase), 'Removes tests').join(', ');

const MAX_WARNINGS = 50;

const isRegularFile = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

function requireLockable(root, phase) {
  const locked = lockedTests(root, phase);
  for (const path of locked) {
    if (isAbsolute(path) || path.includes('\\')) refuse(`locked test ${path}: write it as a path relative to the project folder, with forward slashes.`);
    const rel = toProjectPath(root, path);
    if (!rel || rel === '.phaseproof' || rel.startsWith('.phaseproof/')) refuse(`locked test ${path} is outside the project. List paths relative to the project folder.`);
    if (linkedPath(root, rel)) refuse(`locked test ${path} is or sits under a symlink. Lock the real file.`);
    if (!isRegularFile(join(root, rel))) refuse(`locked test ${path} does not exist yet, or is not a file. Write it before approval, or take it off **Locked tests:**.`);
    if (!exactCase(root, rel)) refuse(`locked test ${path} differs in upper and lower case from the file on disk. Use the exact name.`);
    if (!isTestFile(rel)) refuse(`locked test ${path} does not look like a test file. Only tests can be locked.`);
  }
  return locked;
}

const listed = (paths, max = 10) => `${paths.slice(0, max).join(', ')}${paths.length > max ? ` and ${paths.length - max} more` : ''}`;

function testWarnings(root, phase, approval) {
  try {
    const base = approval.base ?? approval.head ?? null;
    if (base === null) {
      return [gitHead(root) === null && !existsSync(join(root, '.git')) ? 'tests were not compared: this project is not a git repository' : 'tests were not compared: this phase was approved before the repository had any history'];
    }
    const tests = testTampering(root, base, removalAllowance(root, phase));
    const all = [
      ...(tests?.unverifiable ? [`tests were not compared: the approval's base commit ${String(tests.unverifiable).slice(0, 12)} is gone (rebase or gc). /phaseproof:approve ${phase} --new-base records a new one`] : []),
      ...(tests?.unchecked ? [`tests were not compared: ${tests.unchecked}`] : []),
      ...(tests?.removed ?? []).map((f) => `possible deleted test: ${f} (restore it, stage a move with git add -A, or have the owner list it under **Removes tests:**)`),
      ...(tests?.skipped ?? []).map((s) => `possible skip or focus added in ${s.file}: ${s.line}`),
      ...(tests?.incomplete ? ['the skip check could not read every test diff'] : []),
    ];
    return all.length > MAX_WARNINGS ? [...all.slice(0, MAX_WARNINGS), `and ${all.length - MAX_WARNINGS} more`] : all;
  } catch (e) {
    return [`tests were not compared: ${e.message}`];
  }
}

function requireActive(root) {
  if (!isActive(root)) refuse('this project is not tracked yet. Run: phaseproof init');
  return loadState(root);
}

function requireReview(root, phase, kind) {
  const text = readText(reviewFile(root, phase, kind));
  const v = parseVerdict(text);
  if (!v.pass) refuse(`${kind} review for phase ${phase}: ${v.reason} (.phaseproof/reviews/phase-${phase}-${kind}.md)`);
  return text;
}

function checkResults(root, phase) {
  const commands = [...loadConfig(root).checks, ...gateRuns(root, phase)];
  if (!commands.length) refuse('no checks configured. Add commands to "checks" in .phaseproof/config.json, or to **Gate runs:** in the phase scope');
  const results = runChecks(root, commands);
  const approval = readJson(approvalFile(root, phase), null);
  const base = approval?.base ?? approval?.head ?? null;
  const fingerprint = base ? codeFingerprint(root, base) : null;
  writeJson(runFile(root, phase), { phase, ranAt: new Date().toISOString(), head: gitHead(root), results, ...(fingerprint ? { base, fingerprint } : {}) });
  return results;
}

const describe = (results) => results.map((r) => `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.cmd} (${r.ms} ms)`).join('\n');

const commands = {
  init(root, args, out) {
    if (isActive(root)) return out('already tracked. Run: phaseproof status');
    const checks = [];
    let phase = '01';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check' && args[i + 1]) checks.push(args[++i]);
      else if (args[i] === '--phase' && args[i + 1]) phase = padPhase(args[++i]);
    }
    writeJson(ppPath(root, 'config.json'), { ...loadConfig(root), checks });
    writeJson(ppPath(root, 'state.json'), { version: 1, phase });
    for (const d of ['reviews', 'approvals', 'gates', 'runs', 'blocks']) mkdirSync(ppPath(root, d), { recursive: true });
    out(`tracking started at phase ${phase}${checks.length ? '' : '. Add your test/typecheck commands to .phaseproof/config.json'}`);
  },

  status(root, _args, out) {
    const { phase } = requireActive(root);
    const dir = phaseDir(root, phase);
    const docs = parseVerdict(readText(reviewFile(root, phase, 'docs')));
    const code = parseVerdict(readText(reviewFile(root, phase, 'code')));
    const run = readJson(runFile(root, phase), null);
    const approved = existsSync(approvalFile(root, phase));
    const block = readJson(blockFile(root, phase), null);
    const size = (readJson(approvalFile(root, phase), {}) ?? {}).size;
    const lines = [
      `phase ${phase}${dir ? ` (${dir.split(/[\\/]/).pop()})` : ' (no phase folder yet)'}${size === 'quick' ? ', approved as quick' : ''}`,
      `  docs review  ${docs.pass ? 'pass' : size === 'quick' ? `skipped, the owner approved it as quick (${docs.reason})` : docs.reason}`,
      `  approved     ${approved ? (scopeChanged(root, phase) ? 'stale, scope changed since approval' : configChanged(root, phase) ? 'stale, checks or doc paths changed since approval' : 'yes') : 'no'}`,
      `  checks       ${run ? (allPassed(run.results) ? 'pass' : 'failing') : 'not run'}`,
      `  code review  ${code.pass ? 'pass' : code.reason}`,
      `  gate         ${existsSync(gateFile(root, phase)) ? 'passed' : 'open'}`,
    ];
    const locked = lockedTests(root, phase);
    if (locked.length) lines.push(`  locked tests ${listed(locked, 5)}`);
    const budget = scopeBudget(root, phase);
    const approvalBase = readJson(approvalFile(root, phase), {})?.base ?? null;
    const used = budget && approvalBase ? measure(root, approvalBase) : null;
    if (budget && used) {
      const part = (n, max, unit) => (max === null ? `${n} ${unit}` : `${n}/${max} ${unit}`);
      lines.push(`  budget       ${part(used.lines, budget.lines, 'lines')}, ${part(used.files, budget.files, 'files')}${overBudget(budget, used) ? ', OVER' : ''}`);
    }
    if (block) lines.push(`  BLOCKED      ${block.reason}, waiting on the owner`);
    out(lines.join('\n'));
  },

  approve(root, args, out) {
    const { phase: current } = requireActive(root);
    const unknown = args.filter((a) => a.startsWith('--') && !['--quick', '--new-base'].includes(a));
    if (unknown.length) refuse(`unknown option ${unknown.join(', ')}. Options: --quick, --new-base`);
    const phase = padPhase(args.find((a) => !a.startsWith('--')) ?? current);
    if (phase !== current) refuse(`current phase is ${current}, not ${phase}`);
    const dir = requireOneFolder(root, phase);
    if (!dir || !existsSync(join(dir, 'scope.md'))) refuse(`write phases/phase-${phase}-<name>/scope.md first`);
    const previous = readJson(approvalFile(root, phase), null);
    const existingDocs = readText(reviewFile(root, phase, 'docs'));
    const quick = args.includes('--quick');
    const docsText = quick ? existingDocs : requireReview(root, phase, 'docs');
    const docs = docsText ? sha256(docsText) : null;
    if (existsSync(join(dir, 'screens.md'))) requireReview(root, phase, 'design');
    const locked = requireLockable(root, phase);
    const scope = scopeHash(root, phase);
    if (!quick && previous?.scopeHash && previous.scopeHash !== scope && previous.docsReview === docs) {
      refuse(`phase ${phase} scope changed since the last approval. Get a fresh docs review first.`);
    }
    const head = gitHead(root);
    const base = args.includes('--new-base') ? head : (previous?.base ?? previous?.head ?? head);
    writeJson(approvalFile(root, phase), { phase, approvedAt: new Date().toISOString(), head, base, size: quick ? 'quick' : 'full', scopeHash: scope, docsReview: docs, configHash: configHash(root), locked: lockedDigests(root, phase) });
    const unblocked = existsSync(blockFile(root, phase));
    if (unblocked) rmSync(blockFile(root, phase));
    const notes = [];
    if (quick) notes.push(existingDocs && !parseVerdict(existingDocs).pass ? 'Approved as quick even though its docs review failed.' : 'Approved as quick: no docs review.');
    if (removalAllowance(root, phase)) notes.push(`The scope allows removing tests: ${removalAllowance(root, phase)}.`);
    if (locked.length) notes.push(`Locked tests, closed to edits until the gate: ${listed(locked)}.`);
    const dropped = Object.keys(previous?.locked && typeof previous.locked === 'object' ? previous.locked : {}).filter((p) => !locked.includes(p));
    if (dropped.length) notes.push(`No longer locked: ${listed(dropped)}.`);
    const { checks, docPaths } = loadConfig(root);
    const runs = gateRuns(root, phase);
    notes.push(checks.length ? `The gate will run: ${checks.join(' ; ')}.` : runs.length ? 'No project checks are configured.' : 'No checks are configured, so the gate cannot pass until .phaseproof/config.json has some.');
    if (runs.length) notes.push(`For this phase it also runs: ${runs.join(' ; ')}.`);
    const budget = scopeBudget(root, phase);
    const count = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    if (budget) notes.push(`Budget: ${[budget.lines !== null ? count(budget.lines, 'line') : null, budget.files !== null ? count(budget.files, 'file') : null].filter(Boolean).join(', ')} of code.`);
    if (JSON.stringify(docPaths) !== JSON.stringify(DEFAULT_CONFIG.docPaths)) notes.push(`Always writable as docs: ${docPaths.filter(usableDocPath).join(', ') || 'Markdown files only'}.`);
    out(`phase ${phase} approved. Code is open for this phase.${unblocked ? ' Block cleared.' : ''}${notes.length ? ` ${notes.join(' ')}` : ''}`);
  },

  check(root, args, out) {
    const { phase: current } = requireActive(root);
    const phase = padPhase(args[0] ?? current);
    const results = checkResults(root, phase);
    out(describe(results));
    if (!allPassed(results)) refuse('checks failing');
  },

  gate(root, args, out) {
    const { phase: current } = requireActive(root);
    const phase = padPhase(args[0] ?? current);
    if (!existsSync(approvalFile(root, phase))) refuse(`phase ${phase} was never approved`);
    requireOneFolder(root, phase);
    if (existsSync(blockFile(root, phase))) refuse(`phase ${phase} is blocked. The owner has to approve it again first`);
    if (scopeChanged(root, phase)) {
      const locked = changedLocked(root, phase);
      refuse(locked.length ? `locked test ${listed(locked)} changed since phase ${phase} was approved. The owner restores it, or approves again` : `phase ${phase} scope changed since approval (scope.md, tasks.md, screens.md or the list of locked tests). Review it and approve again`);
    }
    if (configChanged(root, phase)) refuse(`the checks or doc paths in .phaseproof/config.json changed since phase ${phase} was approved. The owner approves again`);
    const approval = (readJson(approvalFile(root, phase), {}) ?? {});
    const docs = approval.size === 'quick' ? readText(reviewFile(root, phase, 'docs')) : requireReview(root, phase, 'docs');
    const code = requireReview(root, phase, 'code');
    const drift = reviewDrift(root, phase, approval, code);
    if (drift.unknown) refuse(`code could not be compared with the code review: ${drift.unknown}`);
    if (drift.changed.length) {
      refuse(`code changed after the code review was saved: ${listed(drift.changed)}. Review the current code again. If a check, formatter or build wrote these files, commit or gitignore that output before the review`);
    }
    const tests = testWarnings(root, phase, approval);
    const over = overBudget(scopeBudget(root, phase), measure(root, approval.base ?? approval.head ?? null));
    const warnings = [
      ...(drift.warning ? [drift.warning] : []),
      ...drift.fresh.slice(0, 10).map((f) => `untracked file that appeared after the code review: ${f}`),
      ...(drift.fresh.length > 10 ? [`and ${drift.fresh.length - 10} more untracked files that appeared after the code review`] : []),
      ...(over ? [`this phase changed ${over}. Split the rest into the next phase, or the owner raises the budget and approves again`] : []),
      ...tests,
    ];
    const results = checkResults(root, phase);
    out(describe(results));
    if (warnings.length) out(`check before trusting this gate (warnings, the gate does not block on them):\n  ${warnings.join('\n  ')}`);
    if (!allPassed(results)) refuse('checks failing, gate stays open');
    writeJson(gateFile(root, phase), {
      phase,
      passedAt: new Date().toISOString(),
      head: gitHead(root),
      checks: results.map(({ cmd, code: c, ms }) => ({ cmd, code: c, ms })),
      reviews: { docs: docs ? sha256(docs) : null, code: sha256(code) },
      warnings,
      testWarnings: tests,
    });
    out(`phase ${phase} gate: PASS`);
  },

  block(root, args, out) {
    const { phase: current } = requireActive(root);
    const phase = padPhase(args[0] ?? current);
    const v = parseVerdict(readText(reviewFile(root, phase, 'code')));
    if (v.pass || v.reason === 'no review report') refuse(`block is for a failed code review, and phase ${phase} has none`);
    writeJson(blockFile(root, phase), { phase, blockedAt: new Date().toISOString(), reason: v.reason, blockers: v.blockers.slice(0, 20) });
    out(`phase ${phase} blocked: ${v.reason}. Code is closed until the owner runs /phaseproof:approve ${phase}.`);
  },

  next(root, _args, out) {
    const state = requireActive(root);
    if (!existsSync(gateFile(root, state.phase))) refuse(`phase ${state.phase} has not passed its gate`);
    const phase = padPhase(Number(state.phase) + 1);
    writeJson(ppPath(root, 'state.json'), { ...state, phase });
    out(`now on phase ${phase}. Write its scope and tasks, get them reviewed, then ask the owner to approve.`);
  },
};

export function main(argv, { root = process.cwd(), out = console.log, err = console.error } = {}) {
  const [name, ...args] = argv;
  const cmd = commands[name];
  if (!cmd) {
    (name ? err : out)(USAGE);
    return name ? 2 : 0;
  }
  try {
    cmd(root, args, out);
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof Error && e.message.startsWith('not a phase number'))) throw e;
    err(`phaseproof: ${e.message}`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), { root: process.env.CLAUDE_PROJECT_DIR || process.cwd() });
}
