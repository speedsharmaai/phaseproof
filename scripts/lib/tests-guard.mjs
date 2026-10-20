import { spawnSync } from 'node:child_process';

const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|Tests?\.(cs|java|kt|swift)$|_spec\.rb$/i;
const SKIP =
  /\.(skip|only)\s*\(|\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(|\b(it|test)\.todo\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.skip|\bt\.Skip(Now|f)?\s*\(|#\[ignore\]|@Disabled\b|@Ignore\b/;

const git = (root, args) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

export const isTestFile = (path) => TEST_FILE.test(path);

export function testTampering(root, base, allowed = '') {
  if (!base) return null;
  const names = git(root, ['diff', '--name-status', '--no-renames', '-z', base]);
  if (names.status !== 0) return null;
  const parts = names.stdout.split('\0').filter(Boolean);
  const removed = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === 'D' && isTestFile(parts[i + 1])) removed.push(parts[i + 1]);
  }

  const diff = git(root, ['diff', '--no-color', '--no-renames', '-U0', base]);
  const skipped = [];
  let file = null;
  for (const line of diff.status === 0 ? diff.stdout.split('\n') : []) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
    } else if (file && isTestFile(file) && line.startsWith('+') && SKIP.test(line)) {
      skipped.push({ file, line: line.slice(1).trim().slice(0, 120) });
    }
  }

  const ok = (path) => allowed.includes(path);
  const result = { removed: removed.filter((p) => !ok(p)), skipped: skipped.filter((s) => !ok(s.file)) };
  return result.removed.length || result.skipped.length ? result : null;
}
