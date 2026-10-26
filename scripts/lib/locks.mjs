import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { exactCase, linkedPath, lockedTests, toProjectPath } from './project.mjs';
import { isTestFile } from './tests-guard.mjs';

const isRegularFile = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

export function lockIssue(root, path) {
  if (isAbsolute(path) || path.includes('\\')) return `locked test ${path}: write it as a path relative to the project folder, with forward slashes.`;
  const rel = toProjectPath(root, path);
  if (!rel || rel === '.phaseproof' || rel.startsWith('.phaseproof/')) return `locked test ${path} is outside the project. List paths relative to the project folder.`;
  if (linkedPath(root, rel)) return `locked test ${path} is or sits under a symlink. Lock the real file.`;
  if (!isRegularFile(join(root, rel))) return `locked test ${path} does not exist yet, or is not a file. Write it before approval, or take it off **Locked tests:**.`;
  if (!exactCase(root, rel)) return `locked test ${path} differs in upper and lower case from the file on disk. Use the exact name.`;
  if (!isTestFile(rel)) return `locked test ${path} does not look like a test file. Only tests can be locked.`;
  return null;
}

export const lockIssues = (root, phase) => lockedTests(root, phase).map((p) => lockIssue(root, p)).filter(Boolean);
