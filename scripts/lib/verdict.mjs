const VERDICT = /^\s*VERDICT:\s*(PASS|FAIL)\b(?![^\n]*\|)/im;
const BLOCKER = /^\s*(?:[-*+]|\d+[.)])\s*\[blocker\]/i;
const plain = (text) => text.replace(/\*\*|__|`/g, '');

export function parseVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return { pass: false, reason: 'no review report', blockers: [] };
  const blockers = text.split(/\r?\n/).filter((line) => BLOCKER.test(plain(line)));
  const m = VERDICT.exec(plain(text));
  if (!m) return { pass: false, reason: 'no VERDICT line', blockers };
  if (m[1].toUpperCase() === 'FAIL') return { pass: false, reason: 'verdict is FAIL', blockers };
  if (blockers.length) return { pass: false, reason: `PASS with ${blockers.length} open blocker(s)`, blockers };
  return { pass: true, reason: 'pass', blockers };
}
