import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDoc } from './decide.mjs';
import { ensureLine, inStateDir, isActive, loadConfig, ppPath, readJson, toProjectPath, writeJson } from './project.mjs';

const editFile = (root) => ppPath(root, 'cache', 'last-edit.json');

function writable(file) {
  try {
    if (lstatSync(dirname(file)).isSymbolicLink()) return false;
  } catch {}
  try {
    return lstatSync(file).isFile();
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

export function recordEdit(root, file, now = new Date()) {
  try {
    if (!isActive(root)) return;
    const rel = toProjectPath(root, String(file ?? ''));
    if (!rel || inStateDir(rel) || isDoc(rel, loadConfig(root).docPaths)) return;
    if (!writable(editFile(root))) return;
    ensureLine(ppPath(root, '.gitignore'), 'cache/');
    writeJson(editFile(root), { at: now.toISOString(), file: rel });
  } catch {}
}

export function lastEdit(root) {
  const at = Date.parse(readJson(editFile(root), null)?.at ?? '');
  return Number.isFinite(at) ? at : null;
}
