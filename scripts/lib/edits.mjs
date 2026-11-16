import { lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    let mtime = null;
    try {
      mtime = statSync(join(root, rel)).mtimeMs;
    } catch {}
    writeJson(editFile(root), { at: now.toISOString(), mtime, file: rel });
  } catch {}
}

export function lastEdit(root) {
  const record = readJson(editFile(root), null);
  const at = Date.parse(record?.at ?? '');
  const mtime = typeof record?.mtime === 'number' && Number.isFinite(record.mtime) ? record.mtime : null;
  return { at: Number.isFinite(at) ? at : null, mtime };
}
