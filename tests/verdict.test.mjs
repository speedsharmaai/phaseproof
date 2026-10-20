import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../scripts/lib/verdict.mjs';

test('pass with only minor findings', () => {
  assert.equal(parseVerdict('VERDICT: PASS\n- [minor] a.js:1 naming').pass, true);
});

test('fail verdict', () => {
  assert.deepEqual(parseVerdict('VERDICT: FAIL\n').pass, false);
});

test('pass that still lists a blocker is not a pass', () => {
  const v = parseVerdict('VERDICT: PASS\n- [blocker] a.js:4 crashes on empty input');
  assert.equal(v.pass, false);
  assert.match(v.reason, /1 open blocker/);
});

test('missing or empty report', () => {
  assert.equal(parseVerdict(null).reason, 'no review report');
  assert.equal(parseVerdict('looks good to me').reason, 'no VERDICT line');
});

test('verdict line is case-insensitive and may be indented', () => {
  assert.equal(parseVerdict('  verdict: pass').pass, true);
});

test('the word PASS inside prose does not count', () => {
  assert.equal(parseVerdict('I would say VERDICT: PASS overall').pass, false);
});
