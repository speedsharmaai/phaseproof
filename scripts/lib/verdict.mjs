const VERDICT = /^\s*VERDICT:\s*(PASS|FAIL)\b/im;
const BLOCKER = /^\s*[-*]\s*\[blocker\]/i;

export function parseVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return { pass: false, reason: 'no review report', blockers: [] };
  const blockers = text.split(/\r?\n/).filter((line) => BLOCKER.test(line));
  const m = VERDICT.exec(text);
  if (!m) return { pass: false, reason: 'no VERDICT line', blockers };
  if (m[1].toUpperCase() === 'FAIL') return { pass: false, reason: 'verdict is FAIL', blockers };
  if (blockers.length) return { pass: false, reason: `PASS with ${blockers.length} open blocker(s)`, blockers };
  return { pass: true, reason: 'pass', blockers };
}
