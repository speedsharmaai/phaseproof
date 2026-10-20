import { readFileSync } from 'node:fs';
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
const git = (root, args) =>
  spawnSync(
    'git',
    ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
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

const lines = (text) => new Set(text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3));
function similar(a, b) {
  const A = lines(a);
  const B = lines(b);
  if (!A.size || !B.size) return a.trim() === b.trim();
  let shared = 0;
  for (const l of A) if (B.has(l)) shared++;
  return shared / Math.max(A.size, B.size) >= 0.5;
}

const readSafe = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function changesSince(root, base) {
  const names = git(root, ['diff', ...DIFF, '--name-status', '-M', '-z', base]);
  if (names.status !== 0) return null;
  const parts = names.stdout.split('\0').filter(Boolean);
  const out = { deleted: [], touched: [], added: [] };
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
    else if (code !== 'D' && watched(path)) {
      out.touched.push(path);
      if (code === 'A') out.added.push(path);
    }
    i += 2;
  }
  return out;
}

function untrackedWatched(root) {
  const run = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (run.status !== 0) return null;
  return run.stdout.split('\0').filter(Boolean).filter(watched);
}

function reallyRemoved(root, base, deleted, newFiles, ok) {
  const candidates = newFiles.filter(isTestFile).map((p) => readSafe(join(root, p))).filter((t) => t !== null);
  return deleted.filter((path) => {
    if (ok(path)) return false;
    const before = git(root, ['show', `${base}:./${path}`]);
    return before.status !== 0 || !candidates.some((text) => similar(before.stdout, text));
  });
}

function skipsInDiff(root, base, touched) {
  if (!touched.length) return { skipped: [], failed: false };
  const diff = git(root, ['diff', ...DIFF, '-M', '-U0', base, '--', ...new Set(touched)]);
  if (diff.status !== 0) return { skipped: [], failed: true };
  const skipped = [];
  let file = null;
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) file = parsePlusPath(line);
    else if (file && line.startsWith('+') && isSkipLine(file, line.slice(1))) skipped.push({ file, line: line.slice(1).trim().slice(0, 120) });
  }
  return { skipped, failed: false };
}

function skipsInFiles(root, paths) {
  return paths.flatMap((path) => {
    const hit = readSafe(join(root, path))?.split('\n').find((line) => isSkipLine(path, line));
    return hit ? [{ file: path, line: hit.trim().slice(0, 120) }] : [];
  });
}

export function testTampering(root, base, allowList = '') {
  if (!base) return null;
  if (git(root, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) {
    return git(root, ['rev-parse', '--git-dir']).status === 0 ? { unverifiable: base } : null;
  }
  const changes = changesSince(root, base);
  if (!changes) return { unverifiable: base };
  const untracked = untrackedWatched(root);
  const removed = reallyRemoved(root, base, changes.deleted, [...changes.added, ...(untracked ?? [])], allowed(allowList));
  const fromDiff = skipsInDiff(root, base, changes.touched);
  const skipped = [...fromDiff.skipped, ...skipsInFiles(root, untracked ?? [])];
  const incomplete = untracked === null || fromDiff.failed;
  return removed.length || skipped.length || incomplete ? { removed, skipped, incomplete } : null;
}
