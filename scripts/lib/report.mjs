import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readHistory } from './history.mjs';
import { approvalFile, blockFile, gateFile, loadState, readJson } from './project.mjs';

function phases(root) {
  const found = new Map();
  try {
    for (const name of readdirSync(join(root, 'phases')).sort()) {
      const m = /^phase-(\d{2,3})(?:-(.*))?$/.exec(name);
      if (!m || String(Number(m[1])).padStart(2, '0') !== m[1] || found.has(m[1])) continue;
      if (statSync(join(root, 'phases', name)).isDirectory()) found.set(m[1], m[2] ?? '');
    }
  } catch {
    // no phases folder
  }
  return found;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function report(root) {
  const current = loadState(root)?.phase ?? null;
  const history = readHistory(root);
  const all = phases(root);
  for (const e of history) if (!all.has(e.phase)) all.set(e.phase, '');
  const rows = [];
  let closed = 0;
  let warnings = 0;
  for (const [phase, name] of [...all].sort(([a], [b]) => Number(a) - Number(b))) {
    const gate = readJson(gateFile(root, phase), null);
    const status = gate ? 'gate passed' : existsSync(blockFile(root, phase)) ? 'blocked' : existsSync(approvalFile(root, phase)) ? 'building' : phase === current ? 'planning' : 'not started';
    if (gate) closed++;
    const code = history.filter((e) => e.phase === phase && e.kind === 'code');
    const failed = code.filter((e) => e.verdict === 'FAIL');
    const blockers = code.reduce((n, e) => n + e.blockers, 0);
    const gateWarnings = Array.isArray(gate?.warnings) ? gate.warnings.length : Array.isArray(gate?.testWarnings) ? gate.testWarnings.length : 0;
    warnings += gateWarnings;
    rows.push(`${phase.padEnd(6)} ${(name || '-').slice(0, 24).padEnd(25)} ${status.padEnd(12)} ${code.length ? `${plural(code.length, 'review')}, ${failed.length} failed, ${plural(blockers, 'blocker finding')}` : '-'}${gate ? `; ${plural(gateWarnings, 'gate warning')}` : ''}`);
  }
  const reviews = history.length;
  const failedAll = history.filter((e) => e.verdict === 'FAIL').length;
  const blockersAll = history.reduce((n, e) => n + e.blockers, 0);
  const lines = ['phaseproof report', '', `${'phase'.padEnd(6)} ${'name'.padEnd(25)} ${'status'.padEnd(12)} code reviews`, ...rows];
  lines.push('', `${plural(closed, 'phase')} closed. ${plural(reviews, 'review')} recorded (docs, design and code), ${failedAll} failed, ${plural(blockersAll, 'blocker finding')} across them, ${plural(warnings, 'gate warning')}.`);
  if (!reviews) lines.push('Review history is recorded from phaseproof 0.7 on, each time a review is saved with the Write or Edit tool.');
  else if (failedAll) lines.push(`${plural(failedAll, 'review')} failed before a gate, so that work was fixed before it closed. A blocker still open across rounds counts once per round.`);
  return lines.join('\n');
}
