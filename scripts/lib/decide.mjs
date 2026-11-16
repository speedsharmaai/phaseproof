import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  approvalFile,
  blockFile,
  changedLocked,
  configChanged,
  currentPhase,
  DEFAULT_CONFIG,
  gateFile,
  inStateDir,
  isActive,
  linkedPath,
  loadConfig,
  lockedTests,
  readJson,
  samePath,
  scopeChanged,
  toProjectPath,
  writeTarget,
} from './project.mjs';
import { isTestFile } from './tests-guard.mjs';

export { toProjectPath };

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PROTECTED_IN_BASH = /\.phaseproof[. ]*[\\/]+(gates|approvals|runs|blocks)\b|phasep~\d+[\\/]+(gates|approvals|runs|blocks)\b/iu;
const APPROVE_IN_BASH = /phaseproof\.mjs["']?\s+approve\b/iu;
const WRITABLE_STATE = [/^\.phaseproof\/reviews\/[a-z0-9._-]+$/, /^\.phaseproof\/config\.json$/];

const allow = { allow: true };
const deny = (reason) => ({ allow: false, reason: `phaseproof: ${reason}` });

export const usableDocPath = (p) => typeof p === 'string' && p.replace(/^[./\\\s]+$/, '') !== '';

export const isDoc = (rel, docPaths) =>
  rel.toLowerCase().endsWith('.md') || docPaths.filter(usableDocPath).some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));

export function decide({ root, toolName, toolInput = {} }) {
  if (!isActive(root)) return allow;

  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    if (PROTECTED_IN_BASH.test(cmd)) return deny('gate, approval and check records are written by the phaseproof script only.');
    if (APPROVE_IN_BASH.test(cmd)) return deny('approval belongs to the owner. Ask them to run /phaseproof:approve.');
    return allow;
  }

  if (!FILE_TOOLS.has(toolName)) return allow;
  const file = toolInput.file_path ?? toolInput.notebook_path;
  if (!file) return allow;
  const typed = toProjectPath(root, String(file));
  const target = writeTarget(root, String(file));
  const rel = toProjectPath(root, target);
  if ((rel && inStateDir(rel)) || (typed && inStateDir(typed))) {
    if (typed === rel && WRITABLE_STATE.some((p) => p.test(rel))) return allow;
    return deny(`${rel ?? typed} is written by the phaseproof script, not by hand.`);
  }
  if (!rel) return allow;

  const locked = lockedReason(root, rel);
  if (locked !== undefined) return locked ? deny(locked) : allow;

  const phase = currentPhase(root);
  const docPaths = phase && configChanged(root, phase) ? DEFAULT_CONFIG.docPaths : loadConfig(root).docPaths;
  if (isDoc(rel, docPaths) && !hardLinked(target)) return allow;

  const reason = closedReason(root);
  return reason ? deny(reason) : allow;
}

function hardLinked(path) {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

const listsPath = (root, paths, rel) => paths.some((p) => samePath(toProjectPath(root, p) ?? '', rel));

function lockedReason(root, rel) {
  const phase = currentPhase(root);
  if (!phase) return undefined;
  const approval = readJson(approvalFile(root, phase), null);
  if (approval) {
    const locked = approval.locked && typeof approval.locked === 'object' ? Object.keys(approval.locked) : [];
    if (!listsPath(root, locked, rel) && !aliases(root, locked, rel)) return undefined;
    return `${rel} is a locked test of phase ${phase}: it was approved with the scope and stays as it is. If it is wrong, stop and tell the owner; they edit it themselves and approve again.`;
  }
  if (!listsPath(root, lockedTests(root, phase), rel) || !isTestFile(rel) || linkedPath(root, rel)) return undefined;
  return committed(root, rel) ? undefined : null;
}

const realPath = (root, rel) => {
  try {
    return realpathSync.native(join(root, rel));
  } catch {
    return null;
  }
};

function aliases(root, locked, rel) {
  const target = locked.length ? realPath(root, rel) : null;
  return Boolean(target) && locked.some((p) => {
    const real = realPath(root, p);
    return real !== null && samePath(real, target);
  });
}

const git = (root, args) => spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10000 });

function committed(root, rel) {
  const tree = git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', '.']);
  if (tree.status === 0) return tree.stdout.split('\0').some((p) => p && samePath(p, rel));
  if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout?.trim() !== 'true') return existsSync(join(root, rel));
  return git(root, ['rev-parse', '-q', '--verify', 'HEAD']).status === 0;
}

export function closedReason(root) {
  const phase = currentPhase(root);
  if (!phase) return '.phaseproof/state.json cannot be read or has no valid phase number. Run /phaseproof:doctor.';
  if (!existsSync(approvalFile(root, phase))) {
    return `phase ${phase} is not approved, so code stays closed. Finish and review the phase docs, then the owner runs /phaseproof:approve ${phase}.`;
  }
  if (existsSync(blockFile(root, phase))) {
    return `phase ${phase} is blocked after two failed code reviews. The owner decides: fix the scope and re-review it, or run /phaseproof:approve ${phase} to give the builder another round.`;
  }
  if (scopeChanged(root, phase)) {
    const quick = readJson(approvalFile(root, phase), {}).size === 'quick';
    const locked = changedLocked(root, phase);
    const what = locked.length
      ? `locked test ${locked.join(', ')} changed after phase ${phase} was approved. If that was not meant to happen, stop and ask the owner to restore it.`
      : `phase ${phase} scope changed after it was approved.`;
    return `${what} ${quick ? `The owner runs /phaseproof:approve ${phase} --quick again, or reviews the docs first for a full approval.` : `Get the docs reviewed again, then the owner runs /phaseproof:approve ${phase}.`}`;
  }
  if (configChanged(root, phase)) {
    return `the checks or doc paths in .phaseproof/config.json changed after phase ${phase} was approved. The owner looks at the change and runs /phaseproof:approve ${phase} again.`;
  }
  if (existsSync(gateFile(root, phase))) {
    return `phase ${phase} already passed its gate. Plan the next phase and get it approved before more code.`;
  }
  return null;
}
