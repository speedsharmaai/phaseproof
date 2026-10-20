import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_FILE = [
  /(^|\/)(tests?|__tests__|spec)\/.+\.(c|m)?[jt]sx?$/,
  /\.(test|spec)\.(c|m)?[jt]sx?$/,
  /_(test|spec)\.(c|m)?[jt]sx?$/,
  /(^|\/)(tests?\/.+|test_[^/]+|[^/]+_test|tests|conftest)\.py$/,
  /_test\.go$/,
  /(^|\/)(spec|test)\/.+\.rb$|_(spec|test)\.rb$/,
  /(^|\/)tests\/.+\.rs$/,
  /(^|\/)[A-Z]\w*Tests?\.(java|kt|cs|swift)$|(^|\/)src\/test\/.+\.(java|kt)$/,
];

const SKIPS = {
  js: [
    /\b(it|test|describe|context|suite|bench)\.(skip|only|todo|fixme|skipIf|runIf)\b/,
    /(?<![\w.$])(xit|xdescribe|xtest|xcontext|fit|fdescribe|fcontext)\s*\(/,
  ],
  py: [/\bpytest\.mark\.(skip|skipif|xfail)\b/, /\.skipTest\s*\(/, /@(unittest\.)?skip(If|Unless)?\b/, /\bpytest\.skip\s*\(/],
  go: [/\b\w+\.Skip(Now|f)?\s*\(/],
  rb: [/(?<![\w.:"'])(xit|xdescribe|xcontext|xspecify|xexample|fit|fdescribe|fcontext|fspecify|skip|pending)\b(?!\s*[=:?!])/, /(^|[\s,(]):focus\b|\bfocus:\s*true\b/],
  rs: [/#\[ignore\b/],
  jvm: [/@(Disabled|Ignore)\b/, /@Test\s*\([^)]*enabled\s*=\s*false/],
  cs: [/\[\s*(Ignore|Explicit)\b/, /\bSkip\s*=\s*"/],
  swift: [/\bXCTSkip\w*\s*\(|throw\s+XCTSkip\b/],
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

export const isTestFile = (path) => TEST_FILE.some((re) => re.test(path));
export const isSkipLine = (path, line) => (SKIPS[kindOf(path)] ?? []).some((re) => re.test(line));

const git = (root, args) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

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

export function testTampering(root, base, allowList = '') {
  if (!base) return null;
  if (git(root, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) {
    return git(root, ['rev-parse', '--git-dir']).status === 0 ? { unverifiable: base } : null;
  }
  const ok = allowed(allowList);

  const names = git(root, ['diff', '--name-status', '-M', '-z', base]);
  if (names.status !== 0) return { unverifiable: base };
  const parts = names.stdout.split('\0').filter(Boolean);
  const removed = [];
  const touched = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const [from, to] = [parts[i + 1], parts[i + 2]];
      if (isTestFile(from) && !isTestFile(to)) removed.push(from);
      if (isTestFile(to) || kindOf(to) === 'rs') touched.push(to);
      i += 3;
    } else {
      const path = parts[i + 1];
      if (code === 'D' && isTestFile(path)) removed.push(path);
      else if (code !== 'D' && (isTestFile(path) || kindOf(path) === 'rs')) touched.push(path);
      i += 2;
    }
  }

  const skipped = [];
  if (touched.length) {
    const diff = git(root, ['diff', '--no-color', '-M', '-U0', base, '--', ...touched]);
    let file = null;
    for (const line of diff.status === 0 ? diff.stdout.split('\n') : []) {
      if (line.startsWith('+++ ')) file = parsePlusPath(line);
      else if (file && line.startsWith('+') && isSkipLine(file, line.slice(1))) skipped.push({ file, line: line.slice(1).trim().slice(0, 120) });
    }
  }

  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const path of untracked.status === 0 ? untracked.stdout.split('\0').filter(Boolean) : []) {
    if (!isTestFile(path) && kindOf(path) !== 'rs') continue;
    let text = '';
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (isSkipLine(path, line)) {
        skipped.push({ file: path, line: line.trim().slice(0, 120) });
        break;
      }
    }
  }

  const result = { removed: removed.filter((p) => !ok(p)), skipped: skipped.filter((s) => !ok(s.file)) };
  return result.removed.length || result.skipped.length ? result : null;
}
