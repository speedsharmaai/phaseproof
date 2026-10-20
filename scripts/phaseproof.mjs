import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { allPassed, runChecks } from './lib/checks.mjs';
import { isMain } from './lib/main.mjs';
import {
  approvalFile,
  gateFile,
  gitHead,
  isActive,
  loadConfig,
  loadState,
  padPhase,
  phaseDir,
  ppPath,
  readJson,
  readText,
  reviewFile,
  runFile,
  writeJson,
} from './lib/project.mjs';
import { parseVerdict } from './lib/verdict.mjs';

const USAGE = `usage: phaseproof <command>

  init [--check "<cmd>"]...   start tracking this project (checks run before every gate)
  status                      current phase and what it is waiting on
  approve <phase>             owner sign-off that opens code for a phase
  check [phase]               run the configured checks and record the result
  gate <phase>                re-run checks, read the code review, close the phase
  next                        move to the next phase once the gate has passed`;

class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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
  const { checks } = loadConfig(root);
  if (!checks.length) refuse('no checks configured. Add commands to "checks" in .phaseproof/config.json');
  const results = runChecks(root, checks);
  writeJson(runFile(root, phase), { phase, ranAt: new Date().toISOString(), head: gitHead(root), results });
  return results;
}

const describe = (results) => results.map((r) => `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.cmd} (${r.ms} ms)`).join('\n');

const commands = {
  init(root, args, out) {
    if (isActive(root)) return out('already tracked. Run: phaseproof status');
    const checks = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--check' && args[i + 1]) checks.push(args[++i]);
    writeJson(ppPath(root, 'config.json'), { ...loadConfig(root), checks });
    writeJson(ppPath(root, 'state.json'), { version: 1, phase: '01' });
    for (const d of ['reviews', 'approvals', 'gates', 'runs']) mkdirSync(ppPath(root, d), { recursive: true });
    out(`tracking started at phase 01${checks.length ? '' : '. Add your test/typecheck commands to .phaseproof/config.json'}`);
  },

  status(root, _args, out) {
    const { phase } = requireActive(root);
    const dir = phaseDir(root, phase);
    const docs = parseVerdict(readText(reviewFile(root, phase, 'docs')));
    const code = parseVerdict(readText(reviewFile(root, phase, 'code')));
    const run = readJson(runFile(root, phase), null);
    const lines = [
      `phase ${phase}${dir ? ` (${dir.split(/[\\/]/).pop()})` : ' (no phase folder yet)'}`,
      `  docs review  ${docs.pass ? 'pass' : docs.reason}`,
      `  approved     ${existsSync(approvalFile(root, phase)) ? 'yes' : 'no'}`,
      `  checks       ${run ? (allPassed(run.results) ? 'pass' : 'failing') : 'not run'}`,
      `  code review  ${code.pass ? 'pass' : code.reason}`,
      `  gate         ${existsSync(gateFile(root, phase)) ? 'passed' : 'open'}`,
    ];
    out(lines.join('\n'));
  },

  approve(root, args, out) {
    const { phase: current } = requireActive(root);
    const phase = padPhase(args[0] ?? current);
    if (phase !== current) refuse(`current phase is ${current}, not ${phase}`);
    const dir = phaseDir(root, phase);
    if (!dir || !existsSync(join(dir, 'scope.md'))) refuse(`write phases/phase-${phase}-<name>/scope.md first`);
    requireReview(root, phase, 'docs');
    if (existsSync(join(dir, 'screens.md'))) requireReview(root, phase, 'design');
    writeJson(approvalFile(root, phase), { phase, approvedAt: new Date().toISOString(), head: gitHead(root) });
    out(`phase ${phase} approved. Code is open for this phase.`);
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
    const docs = requireReview(root, phase, 'docs');
    const code = requireReview(root, phase, 'code');
    const results = checkResults(root, phase);
    out(describe(results));
    if (!allPassed(results)) refuse('checks failing, gate stays open');
    writeJson(gateFile(root, phase), {
      phase,
      passedAt: new Date().toISOString(),
      head: gitHead(root),
      checks: results.map(({ cmd, code: c, ms }) => ({ cmd, code: c, ms })),
      reviews: { docs: sha256(docs), code: sha256(code) },
    });
    out(`phase ${phase} gate: PASS`);
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
