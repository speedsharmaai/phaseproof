const VERDICT = /^\s*VERDICT:\s*(PASS|FAIL)\b/i;
const TEMPLATE = /^\s*VERDICT:\s*PASS\s*\|\s*FAIL\s*$/i;
const BLOCKER = /^\s*(?:[-*+]|\d+[.)])\s*\[blocker\]/i;
const plain = (line) => line.replace(/\*\*|__|`/g, '');

export function parseVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return { pass: false, reason: 'no review report', blockers: [] };
  const lines = text.split(/\r?\n/);
  const blockers = lines.filter((line) => BLOCKER.test(plain(line)));
  const verdicts = lines
    .map(plain)
    .filter((line) => !TEMPLATE.test(line))
    .map((line) => VERDICT.exec(line)?.[1].toUpperCase())
    .filter(Boolean);
  if (!verdicts.length) return { pass: false, reason: 'no VERDICT line', blockers };
  if (verdicts.includes('FAIL')) return { pass: false, reason: 'verdict is FAIL', blockers };
  if (blockers.length) return { pass: false, reason: `PASS with ${blockers.length} open blocker(s)`, blockers };
  return { pass: true, reason: 'pass', blockers };
}
