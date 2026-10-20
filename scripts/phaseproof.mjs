import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allPassed, runChecks } from './lib/checks.mjs';
import { isMain } from './lib/main.mjs';
import {
  approvalFile,
  blockFile,
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
  scopeChanged,
  scopeHash,
  sha256,
  writeJson,
} from './lib/project.mjs';
import { parseVerdict } from './lib/verdict.mjs';

const USAGE = `usage: phaseproof <command>

  init [--check "<cmd>"]... [--phase NN]
                              start tracking this project (checks run before every gate)
  status                      current phase and what it is waiting on
  approve <phase>             owner sign-off that opens code for a phase (also clears a block)
  check [phase]               run the configured checks and record the result
  gate <phase>                re-run checks, read the code review, close the phase
  block [phase]               stop the phase after a failed code review until the owner decides
  next                        move to the next phase once the gate has passed`;

class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

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
    let phase = '01';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check' && args[i + 1]) checks.push(args[++i]);
      else if (args[i] === '--phase' && args[i + 1]) phase = padPhase(args[++i]);
    }
    writeJson(ppPath(root, 'config.json'), { ...loadConfig(root), checks });
    writeJson(ppPath(root, 'state.json'), { version: 1, phase });
    for (const d of ['reviews', 'approvals', 'gates', 'runs', 'blocks']) mkdirSync(ppPath(root, d), { recursive: true });
    try {
      writeFileSync(ppPath(root, '.gitignore'), 'shell/\n', { flag: 'wx' });
    } catch {}
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
    const lines = [
      `phase ${phase}${dir ? ` (${dir.split(/[\\/]/).pop()})` : ' (no phase folder yet)'}`,
      `  docs review  ${docs.pass ? 'pass' : docs.reason}`,
      `  approved     ${approved ? (scopeChanged(root, phase) ? 'stale, scope changed since approval' : 'yes') : 'no'}`,
      `  checks       ${run ? (allPassed(run.results) ? 'pass' : 'failing') : 'not run'}`,
      `  code review  ${code.pass ? 'pass' : code.reason}`,
      `  gate         ${existsSync(gateFile(root, phase)) ? 'passed' : 'open'}`,
    ];
    if (block) lines.push(`  BLOCKED      ${block.reason}, waiting on the owner`);
    out(lines.join('\n'));
  },

  approve(root, args, out) {
    const { phase: current } = requireActive(root);
    const phase = padPhase(args[0] ?? current);
    if (phase !== current) refuse(`current phase is ${current}, not ${phase}`);
    const dir = phaseDir(root, phase);
    if (!dir || !existsSync(join(dir, 'scope.md'))) refuse(`write phases/phase-${phase}-<name>/scope.md first`);
    const docs = sha256(requireReview(root, phase, 'docs'));
    if (existsSync(join(dir, 'screens.md'))) requireReview(root, phase, 'design');
    const scope = scopeHash(root, phase);
    const previous = readJson(approvalFile(root, phase), null);
    if (previous?.scopeHash && previous.scopeHash !== scope && previous.docsReview === docs) {
      refuse(`phase ${phase} scope changed since the last approval. Get a fresh docs review first.`);
    }
    writeJson(approvalFile(root, phase), { phase, approvedAt: new Date().toISOString(), head: gitHead(root), scopeHash: scope, docsReview: docs });
    const unblocked = existsSync(blockFile(root, phase));
    if (unblocked) rmSync(blockFile(root, phase));
    out(`phase ${phase} approved. Code is open for this phase.${unblocked ? ' Block cleared.' : ''}`);
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
    if (existsSync(blockFile(root, phase))) refuse(`phase ${phase} is blocked. The owner has to approve it again first`);
    if (scopeChanged(root, phase)) refuse(`phase ${phase} scope changed since approval. Review it and approve again`);
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
