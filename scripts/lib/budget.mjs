import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDoc } from './decide.mjs';
import { loadConfig } from './project.mjs';

const MAX_COUNTED_BYTES = 1024 * 1024;
const git = (root, args) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 20000,
  });

const isCode = (rel, docPaths) => rel !== '.phaseproof' && !rel.startsWith('.phaseproof/') && !isDoc(rel, docPaths);

function lineCount(root, rel) {
  try {
    const path = join(root, rel);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_COUNTED_BYTES) return 0;
    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) return 0;
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

export function measure(root, base) {
  if (typeof base !== 'string' || !/^[0-9a-f]{7,64}$/.test(base)) return null;
  const { docPaths } = loadConfig(root);
  const numstat = git(root, ['diff', '--no-ext-diff', '--no-textconv', '-M', '--relative', '--numstat', '-z', base, '--', '.']);
  const others = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  if (numstat.status !== 0 || others.status !== 0) return null;
  let lines = 0;
  const files = new Set();
  const parts = numstat.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [added, deleted, ...rest] = parts[i].split('\t');
    let path = rest.join('\t');
    if (!path) {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    if (!path || !isCode(path, docPaths)) continue;
    files.add(path);
    lines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  for (const path of others.stdout.split('\0').filter(Boolean)) {
    if (!isCode(path, docPaths) || files.has(path)) continue;
    files.add(path);
    lines += lineCount(root, path);
  }
  return { lines, files: files.size };
}

export function overBudget(budget, used) {
  if (!budget || !used) return null;
  const over = [];
  if (budget.lines !== null && used.lines > budget.lines) over.push(`${used.lines} lines (budget ${budget.lines})`);
  if (budget.files !== null && used.files > budget.files) over.push(`${used.files} files (budget ${budget.files})`);
  return over.length ? over.join(' and ') : null;
}
