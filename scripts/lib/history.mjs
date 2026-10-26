import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isActive, padPhase, ppPath, readText, sha256, toProjectPath } from './project.mjs';
import { parseVerdict } from './verdict.mjs';

const REVIEW = /^\.phaseproof\/reviews\/phase-(\d{1,3})-(docs|code|design)\.md$/;
export const historyFile = (root) => ppPath(root, 'runs', 'reviews.jsonl');

export function readHistory(root) {
  const text = readText(historyFile(root)) ?? '';
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.phase === 'string' && ['docs', 'code', 'design'].includes(e.kind) && ['PASS', 'FAIL'].includes(e.verdict)) {
        out.push({ ...e, blockers: Number.isInteger(e.blockers) && e.blockers >= 0 ? e.blockers : 0 });
      }
    } catch {
      // a damaged line is skipped
    }
  }
  return out;
}

export function recordHistory(root, file) {
  const rel = toProjectPath(root, String(file ?? ''));
  const m = rel ? REVIEW.exec(rel) : null;
  if (!m || !isActive(root) || padPhase(m[1]) !== m[1]) return false;
  const [, phase, kind] = m;
  const text = readText(ppPath(root, 'reviews', `phase-${phase}-${kind}.md`));
  if (!text || !text.trim()) return false;
  const review = sha256(text);
  if (readHistory(root).some((e) => e.review === review && e.phase === phase && e.kind === kind)) return false;
  const v = parseVerdict(text);
  const entry = { phase, kind, verdict: v.pass ? 'PASS' : 'FAIL', blockers: v.blockers.length, at: new Date().toISOString(), review };
  mkdirSync(dirname(historyFile(root)), { recursive: true });
  const existing = readText(historyFile(root)) ?? '';
  appendFileSync(historyFile(root), `${existing && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n`);
  return true;
}
