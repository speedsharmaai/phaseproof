import { lstatSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDoc } from './decide.mjs';
import { approvalFile, isActive, loadConfig, ppPath, readJson, readText, reviewFile, sha256, toProjectPath, writeJson } from './project.mjs';

const TIMEOUT_MS = 20000;
const git = (root, args, input) =>
  spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  });
const zlist = (r) => (r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null);
const isCode = (rel, docPaths) => rel !== '.phaseproof' && !rel.startsWith('.phaseproof/') && !isDoc(rel, docPaths);

function contentHashes(root, paths) {
  const out = Object.create(null);
  const regular = [];
  for (const path of paths) {
    try {
      const st = lstatSync(join(root, path));
      if (st.isSymbolicLink()) out[path] = `link:${sha256(readlinkSync(join(root, path)))}`;
      else if (st.isFile()) regular.push(path);
      else out[path] = 'not-a-file';
    } catch {
      out[path] = 'deleted';
    }
  }
  if (!regular.length) return out;
  if (regular.some((p) => p.includes('\n'))) return null;
  const r = git(root, ['hash-object', '--no-filters', '--stdin-paths'], `${regular.map((p) => join(root, p)).join('\n')}\n`);
  const oids = r.status === 0 ? r.stdout.trim().split('\n') : [];
  if (oids.length !== regular.length) return null;
  regular.forEach((p, i) => {
    out[p] = oids[i];
  });
  return out;
}

export function codeFingerprint(root, base) {
  if (typeof base !== 'string' || !/^[0-9a-f]{7,64}$/.test(base)) return null;
  const { docPaths } = loadConfig(root);
  const tracked = zlist(git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '--name-only', '-z', base, '--', '.']));
  const untracked = zlist(git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']));
  if (!tracked || !untracked) return null;
  const t = contentHashes(root, tracked.filter((p) => isCode(p, docPaths)));
  const u = contentHashes(root, untracked.filter((p) => isCode(p, docPaths)));
  return t && u ? { tracked: t, untracked: u } : null;
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
export const isFingerprint = (fp) => fp !== null && typeof fp === 'object' && isMap(fp.tracked) && isMap(fp.untracked);

const kind = (fp, p) => (Object.hasOwn(fp.tracked, p) ? 'tracked' : Object.hasOwn(fp.untracked, p) ? 'untracked' : null);
const value = (fp, p) => (Object.hasOwn(fp.tracked, p) ? fp.tracked[p] : fp.untracked[p]);

export function driftSince(before, now) {
  const changed = [];
  const fresh = [];
  const paths = new Set([before, now].flatMap((fp) => [...Object.keys(fp.tracked), ...Object.keys(fp.untracked)]));
  for (const p of [...paths].sort()) {
    const was = kind(before, p);
    const is = kind(now, p);
    if (was && is && value(before, p) === value(now, p)) continue;
    (was || is === 'tracked' ? changed : fresh).push(p);
  }
  return { changed, fresh };
}

const CODE_REVIEW = /^\.phaseproof\/reviews\/phase-(\d{1,3})-code\.md$/;
export const reviewRecordFile = (root, phase) => ppPath(root, 'runs', `phase-${phase}-code-review.json`);
const baseOf = (approval) => approval?.base ?? approval?.head ?? null;

export function recordReview(root, file) {
  const rel = toProjectPath(root, String(file ?? ''));
  const m = rel ? CODE_REVIEW.exec(rel) : null;
  if (!m || !isActive(root)) return false;
  const phase = m[1];
  const text = readText(reviewFile(root, phase, 'code'));
  const base = baseOf(readJson(approvalFile(root, phase), null));
  if (!text || !base) return false;
  const review = sha256(text);
  rmSync(reviewRecordFile(root, phase), { force: true });
  const fingerprint = codeFingerprint(root, base);
  const record = { phase, recordedAt: new Date().toISOString(), base, review };
  writeJson(reviewRecordFile(root, phase), fingerprint ? { ...record, fingerprint } : { ...record, error: `git could not list the code that differs from the approval's base ${base.slice(0, 12)}` });
  return Boolean(fingerprint);
}

const inGit = (root) => git(root, ['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';

export function reviewDrift(root, phase, approval, reviewText) {
  const skip = (why) => ({ changed: [], fresh: [], warning: `code changes made after the code review were not compared: ${why}` });
  if (!baseOf(approval)) return inGit(root) ? skip('the phase was approved before the repository had a commit') : { changed: [], fresh: [] };
  const record = readJson(reviewRecordFile(root, phase), null);
  if (!record) return skip('there is no record of the code it saw. The record is made when the review is saved with the Write or Edit tool; a review saved another way, or a git call that timed out, leaves none');
  if (record.review !== sha256(reviewText)) return skip('the review file is not the one that was recorded. It was changed some other way than the Write or Edit tool');
  if (!isFingerprint(record.fingerprint)) return skip(typeof record.error === 'string' ? record.error : 'the record is damaged');
  const now = codeFingerprint(root, record.base);
  if (!now) return skip('git could not list the code as it is now');
  return driftSince(record.fingerprint, now);
}
