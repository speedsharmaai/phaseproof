import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_FILE = [
  /(^|\/)(tests?|__tests__|spec)\/.+\.(c|m)?[jt]sx?$/,
  /\.(test|spec|cy)\.(c|m)?[jt]sx?$/,
  /_(test|spec)\.(c|m)?[jt]sx?$/,
  /(^|\/)(tests?\/.+|test_[^/]+|[^/]+_test|tests|conftest)\.py$/,
  /_test\.go$/,
  /(^|\/)(spec|test)\/.+\.rb$|_(spec|test)\.rb$/,
  /(^|\/)tests\/.+\.rs$/,
  /(^|\/)[A-Z]\w*(Tests?|Spec|IT)\.(java|kt|cs|swift)$|(^|\/)src\/test\/.+\.(java|kt)$/,
];
const NOT_TEST = /(^|\/)(fixtures?|__fixtures__|__snapshots__|testdata|mocks?|__mocks__)\//;

const SKIPS = {
  js: [
    /\b(it|test|describe|context|suite|bench)(\.concurrent)?\.(skip|only|todo|fixme|skipIf|runIf)\b/,
    /(?<![\w.$])(xit|xdescribe|xtest|xcontext|fit|fdescribe|fcontext)\s*\(/,
    /\{\s*[^}]*\b(skip|only|todo)\s*:\s*(true|['"`])/,
    /\b(t|this|ctx|context)\.skip\s*\(/,
  ],
  py: [/\bpytest\.mark\.(skip|skipif|xfail)\b/, /\.skipTest\s*\(/, /@(unittest\.)?(skip(If|Unless)?|expectedFailure)\b/, /\bpytest\.skip\s*\(/, /\bSkipTest\s*\(/],
  go: [/\b(t|b|f|tb)\.Skip(Now|f)?\s*\(/],
  rb: [
    /^\s*(xit|xspecify|xexample|xdescribe|xcontext|fit|fdescribe|fcontext|fspecify)\b\s*[('"]/,
    /^\s*(skip|pending)\b(\s*[('"]|\s*$)/,
    /\b(skip|pending|focus)\s*:\s*(true|['"])/,
    /(^|[\s,(]):focus\b/,
  ],
  rs: [/#\[ignore\b/],
  jvm: [/@(Disabled\w*|Ignore)\b/, /@Test\s*\([^)]*enabled\s*=\s*false/],
  cs: [/\[\s*(Ignore|Explicit)\b/, /\bSkip\s*=\s*"/],
  swift: [/\bXCTSkip\w*\s*\(/, /@Test\s*\([^)]*\.disabled/],
};

const kindOf = (path) => {
  if (/\.(c|m)?[jt]sx?$/.test(path)) return 'js';
  if (path.endsWith('.py')) return 'py';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.rb')) return 'rb';
  if (path.endsWith('.rs')) return 'rs';
  if (/\.(java|kt)$/.test(path)) return 'jvm';
  if (path.endsWith('.cs')) return 'cs';
  if (path.endsWith('.swift')) return 'swift';
  return null;
};

export const isTestFile = (path) => !NOT_TEST.test(path) && TEST_FILE.some((re) => re.test(path));
export const isSkipLine = (path, line) => (SKIPS[kindOf(path)] ?? []).some((re) => re.test(line));
const watched = (path) => isTestFile(path) || kindOf(path) === 'rs';

const DIFF = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--relative'];
const git = (root, args, index) =>
  spawnSync(
    'git',
    ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.renameLimit=0', ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: index ? { ...process.env, GIT_INDEX_FILE: index } : undefined },
  );

function parsePlusPath(line) {
  let rest = line.slice(4);
  if (rest.startsWith('"')) {
    try {
      rest = JSON.parse(rest.replace(/\t.*$/, ''));
    } catch {
      return null;
    }
  } else {
    rest = rest.replace(/\t$/, '');
  }
  return rest.startsWith('b/') ? rest.slice(2) : null;
}

function allowed(list) {
  const items = String(list ?? '')
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter((s) => s && s.toLowerCase() !== 'none');
  return (path) => items.some((item) => path === item || (item.endsWith('/') && path.startsWith(item)));
}

const zlist = (r) => (r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null);

function candidates(root, base, order) {
  const inBase = zlist(git(root, ['ls-tree', '-r', '--name-only', '-z', base, '--', '.']));
  const untracked = zlist(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const changed = zlist(git(root, ['diff', ...DIFF, order, '--name-only', '-z', base]));
  if (!inBase || !untracked || !changed) return null;
  const gone = inBase.filter((p) => isTestFile(p) && !existsSync(join(root, p)));
  return [...new Set([...gone, ...untracked.filter(watched), ...changed.filter(watched)])];
}

function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'phaseproof-'));
  const order = join(dir, 'order');
  writeFileSync(order, '');
  try {
    return fn(join(dir, 'index'), `-O${order}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildTestIndex(root, paths, index) {
  if (git(root, ['read-tree', 'HEAD'], index).status !== 0 && git(root, ['read-tree', '--empty'], index).status !== 0) return false;
  for (let i = 0; i < paths.length; i += 200) git(root, ['add', '-A', '--ignore-errors', '--', ...paths.slice(i, i + 200)], index);
  return true;
}

function changesSince(root, base, index, order, paths) {
  const names = git(root, ['diff', ...DIFF, order, '--cached', '--name-status', '-M75%', '-z', base, '--', ...paths], index);
  if (names.status !== 0) return null;
  const parts = names.stdout.split('\0').filter(Boolean);
  const out = { deleted: [], touched: [] };
  for (let i = 0; i < parts.length; ) {
    const code = parts[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const [from, to] = [parts[i + 1], parts[i + 2]];
      if (isTestFile(from) && !isTestFile(to)) out.deleted.push(from);
      if (watched(to)) out.touched.push(from, to);
      i += 3;
      continue;
    }
    const path = parts[i + 1];
    if (code === 'D' && isTestFile(path)) out.deleted.push(path);
    else if (code !== 'D' && watched(path)) out.touched.push(path);
    i += 2;
  }
  return out;
}

function skipsInDiff(root, base, touched, index, order) {
  if (!touched.length) return { skipped: [], failed: false };
  const diff = git(root, ['diff', ...DIFF, order, '--cached', '-M75%', '-U0', base, '--', ...new Set(touched)], index);
  if (diff.status !== 0) return { skipped: [], failed: true };
  const skipped = [];
  let file = null;
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) file = parsePlusPath(line);
    else if (file && line.startsWith('+') && isSkipLine(file, line.slice(1))) skipped.push({ file, line: line.slice(1).trim().slice(0, 120) });
  }
  return { skipped, failed: false };
}

export function testTampering(root, base, allowList = '') {
  if (!base) return null;
  if (git(root, ['rev-parse', '--git-dir']).status !== 0) return null;
  if (git(root, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) return { unverifiable: base };
  const ok = allowed(allowList);
  return withScratch((index, order) => {
    const paths = candidates(root, base, order);
    if (!paths) return { unchecked: 'git could not list the files that changed since approval' };
    if (!paths.length) return null;
    if (!buildTestIndex(root, paths, index)) return { unchecked: 'git could not build a scratch index for the test files' };
    const changes = changesSince(root, base, index, order, paths);
    if (!changes) return { unchecked: 'git could not compare the test files with the approval base' };
    const removed = changes.deleted.filter((p) => !ok(p));
    const { skipped, failed } = skipsInDiff(root, base, changes.touched, index, order);
    return removed.length || skipped.length || failed ? { removed, skipped, incomplete: failed } : null;
  });
}
