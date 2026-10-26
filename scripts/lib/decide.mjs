import { existsSync } from 'node:fs';
import { approvalFile, blockFile, configChanged, gateFile, isActive, loadConfig, loadState, lockedTests, readJson, scopeChanged, toProjectPath } from './project.mjs';
import { isTestFile } from './tests-guard.mjs';

export { toProjectPath };

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PROTECTED_IN_BASH = /\.phaseproof[\\/]+(gates|approvals|runs|blocks)\b/;
const APPROVE_IN_BASH = /phaseproof\.mjs["']?\s+approve\b/;
const WRITABLE_STATE = ['.phaseproof/reviews/', '.phaseproof/config.json'];

const allow = { allow: true };
const deny = (reason) => ({ allow: false, reason: `phaseproof: ${reason}` });

export const isDoc = (rel, docPaths) =>
  rel.toLowerCase().endsWith('.md') || docPaths.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));

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
  const rel = toProjectPath(root, String(file));
  if (!rel) return allow;

  if (rel.startsWith('.phaseproof/')) {
    if (WRITABLE_STATE.some((p) => rel === p || rel.startsWith(p))) return allow;
    return deny(`${rel} is written by the phaseproof script, not by hand.`);
  }

  if (isDoc(rel, loadConfig(root).docPaths)) return allow;

  const locked = lockedReason(root, rel);
  if (locked !== undefined) return locked ? deny(locked) : allow;

  const reason = closedReason(root);
  return reason ? deny(reason) : allow;
}

function lockedReason(root, rel) {
  const phase = loadState(root)?.phase;
  if (!phase || !lockedTests(root, phase).some((p) => toProjectPath(root, p) === rel)) return undefined;
  if (existsSync(approvalFile(root, phase))) {
    return `${rel} is a locked test of phase ${phase}: it was approved with the scope and stays as it is while the phase builds. If it is wrong, stop and tell the owner; they edit it themselves, or take it off **Locked tests:** and re-approve.`;
  }
  return isTestFile(rel) ? null : `${rel} is listed under **Locked tests:** but is not a test file, so it stays closed until phase ${phase} is approved.`;
}

export function closedReason(root) {
  const phase = loadState(root)?.phase;
  if (!phase) return '.phaseproof/state.json has no current phase. Run /phaseproof:status.';
  if (!existsSync(approvalFile(root, phase))) {
    return `phase ${phase} is not approved, so code stays closed. Finish and review the phase docs, then the owner runs /phaseproof:approve ${phase}.`;
  }
  if (existsSync(blockFile(root, phase))) {
    return `phase ${phase} is blocked after two failed code reviews. The owner decides: fix the scope and re-review it, or run /phaseproof:approve ${phase} to give the builder another round.`;
  }
  if (scopeChanged(root, phase)) {
    const quick = readJson(approvalFile(root, phase), {}).size === 'quick';
    return `phase ${phase} scope changed after it was approved. ${quick ? `The owner runs /phaseproof:approve ${phase} --quick again, or reviews the docs first for a full approval.` : `Get the docs reviewed again, then the owner runs /phaseproof:approve ${phase}.`}`;
  }
  if (configChanged(root, phase)) {
    return `the checks or doc paths in .phaseproof/config.json changed after phase ${phase} was approved. The owner looks at the change and runs /phaseproof:approve ${phase} again.`;
  }
  if (existsSync(gateFile(root, phase))) {
    return `phase ${phase} already passed its gate. Plan the next phase and get it approved before more code.`;
  }
  return null;
}
