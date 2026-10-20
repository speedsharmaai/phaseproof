import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const ORDER = fileURLToPath(new URL('./empty.order', import.meta.url));
const DIFF = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--relative', `-O${ORDER}`];
const git = (root, args, input) =>
  spawnSync(
    'git',
    ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.renameLimit=0', ...args],
    { cwd: root, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
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

const isRegularFile = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

function treeTests(root, rev) {
  const r = git(root, ['ls-tree', '-r', '-z', rev, '--', '.']);
  if (r.status !== 0) return null;
  const out = new Map();
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (type === 'blob' && isTestFile(path)) out.set(path, oid);
  }
  return out;
}

function nameStatus(root, args) {
  const parts = zlist(git(root, ['diff', ...DIFF, '--name-status', '-M75%', '-z', ...args]));
  if (!parts) return null;
  const entries = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      entries.push({ code: code[0], from: parts[i + 1], to: parts[i + 2] });
      i += 3;
    } else {
      entries.push({ code, from: parts[i + 1], to: parts[i + 1] });
      i += 2;
    }
  }
  return entries;
}

const deletedIn = (entries) =>
  entries.filter((e) => (e.code === 'D' && isTestFile(e.from)) || (e.code === 'R' && isTestFile(e.from) && !isTestFile(e.to))).map((e) => e.from);

const readable = (path) => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

function hashFiles(root, all) {
  const paths = all.filter((p) => readable(join(root, p)));
  if (!paths.length) return new Map();
  const r = git(root, ['hash-object', '--no-filters', '--stdin-paths'], paths.join('\n') + '\n');
  if (r.status !== 0) return null;
  const oids = r.stdout.trim().split('\n');
  return new Map(paths.map((p, i) => [p, oids[i]]));
}

function removedSince(root, base) {
  const committed = nameStatus(root, [base, 'HEAD']);
  const staged = nameStatus(root, ['--cached', 'HEAD']);
  const head = treeTests(root, 'HEAD');
  const untracked = zlist(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  if (!committed || !staged || !head || !untracked) return null;

  const index = zlist(git(root, ['ls-files', '-z']));
  if (!index) return null;
  const tracked = new Set(index);
  const stagedAway = new Set(staged.filter((e) => e.code === 'R' && isTestFile(e.to) && isRegularFile(join(root, e.to))).map((e) => e.from));
  const missing = [...head.keys()].filter((p) => !isRegularFile(join(root, p)) && !stagedAway.has(p));
  const newTests = untracked.filter(isTestFile).filter((p) => isRegularFile(join(root, p)));
  const hashes = hashFiles(root, newTests);
  if (!hashes) return null;
  const movedOids = new Set(hashes.values());
  const worktreeGone = missing.filter((p) => !movedOids.has(head.get(p)));

  const lost = (p) => !tracked.has(p) || !isRegularFile(join(root, p));
  const stagedLost = staged.filter((e) => e.code === 'R' && isTestFile(e.from) && !isRegularFile(join(root, e.to))).map((e) => e.from);
  return [...new Set([...deletedIn(committed).filter(lost), ...deletedIn(staged).filter(lost), ...stagedLost, ...worktreeGone])];
}

function skipsSince(root, base) {
  const diff = git(root, ['diff', ...DIFF, '-M75%', '-U0', base]);
  const untracked = zlist(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const skipped = [];
  let file = null;
  for (const line of diff.status === 0 ? diff.stdout.split('\n') : []) {
    if (line.startsWith('+++ ')) file = parsePlusPath(line);
    else if (file && watched(file) && line.startsWith('+') && isSkipLine(file, line.slice(1))) skipped.push({ file, line: line.slice(1).trim().slice(0, 120) });
  }
  const fresh = (untracked ?? []).filter(watched);
  const headOids = new Set((treeTests(root, 'HEAD') ?? new Map()).values());
  const oids = hashFiles(root, fresh) ?? new Map();
  for (const path of fresh.filter((p) => !headOids.has(oids.get(p)))) {
    let text = '';
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    const hit = text.split('\n').find((line) => isSkipLine(path, line));
    if (hit) skipped.push({ file: path, line: hit.trim().slice(0, 120) });
  }
  return { skipped, failed: diff.status !== 0 || !untracked };
}

export function testTampering(root, base, allowList = '') {
  if (!base) return null;
  if (git(root, ['rev-parse', '--git-dir']).status !== 0) return null;
  if (git(root, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) return { unverifiable: base };
  const gone = removedSince(root, base);
  if (!gone) return { unchecked: 'git could not list the test files that changed since approval' };
  const ok = allowed(allowList);
  const removed = gone.filter((p) => !ok(p)).sort();
  const { skipped, failed } = skipsSince(root, base);
  return removed.length || skipped.length || failed ? { removed, skipped, incomplete: failed } : null;
}
