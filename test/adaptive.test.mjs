import assert from 'node:assert/strict';
import { run, summary, formatDate, addDays, solveWindowDays, monthsBetween, parsePostCount } from './harness.mjs';

// Live-observed post counters, captured from real x.com profile pages.
const POST_COUNT_CASES = [
  ['72 posts', 72],
  ['73.6K posts', 73600],
  ['74.3K posts', 74300],
  ['109.1K posts', 109100],
  ['429.2K posts', 429200],
  ['3M posts', 3000000],
  ['1,234,567 posts', 1234567],
  ['0 posts', 0],
  ['no count here', null],
  ['', null]
];

for (const [text, expected] of POST_COUNT_CASES) {
  run(`parsePostCount(${JSON.stringify(text)}) = ${expected}`, () => {
    assert.equal(parsePostCount(text), expected);
  });
}

// The regex must tolerate a missing space before the word "Posts", which is a
// one-character difference from the form X currently renders.
run('parsePostCount tolerates "12KPosts" (no space)', () => {
  assert.equal(parsePostCount('12KPosts'), 12000);
});

run('parsePostCount ignores a different user\'s post count in body text', () => {
  // A timeline can mention another account; the first match is still the
  // profile subject's own counter, which is how X orders the header.
  const text = 'Following 1,412 Following 72 posts Joined January 2023';
  assert.equal(parsePostCount(text), 72);
});

const TODAY = '2026-09-28';

const WINDOW_CASES = [
  { name: 'XboxSupport (3M posts)', posts: 3000000, join: '2009-07-01', expected: 1 },
  { name: 'cnn (429.2K posts)', posts: 429200, join: '2007-02-01', expected: 1 },
  { name: 'elonmusk (109.1K posts)', posts: 109100, join: '2009-06-01', expected: 1 },
  { name: 'natgeo (73.6K posts)', posts: 73600, join: '2008-11-01', expected: 1 }
];

for (const { name, posts, join, expected } of WINDOW_CASES) {
  run(`solveWindowDays clamps high-volume ${name} to ${expected}d`, () => {
    assert.equal(solveWindowDays(posts, join, TODAY), expected);
  });
}

run('solveWindowDays gives a rare poster a wide window (30-60d)', () => {
  const days = solveWindowDays(72, '2023-01-01', TODAY);
  assert.ok(days >= 30 && days <= 60, `expected 30-60 days, got ${days}`);
});

run('solveWindowDays falls back to the widest window for an unknown count', () => {
  assert.equal(solveWindowDays(null, '2023-01-01', TODAY), 90);
});

run('solveWindowDays handles a zero-post account without dividing by zero', () => {
  assert.equal(solveWindowDays(0, '2023-01-01', TODAY), 90);
});

run('solveWindowDays never exceeds the account lifetime', () => {
  // An account created last week cannot be scanned over 90 days.
  const days = solveWindowDays(500, formatDate(addDays(new Date(TODAY), -3)), TODAY);
  assert.ok(days <= 90);
});

run('monthsBetween counts whole months between two dates', () => {
  assert.equal(monthsBetween('2009-07-01', TODAY), 206);
  assert.equal(monthsBetween('2023-01-01', TODAY), 44);
});

run('monthsBetween guards against a join date after today', () => {
  assert.ok(monthsBetween('2030-01-01', TODAY) >= 1);
});

run('a one-post-per-month account needs a window wider than a week', () => {
  // 1 post/month over 12 months: a 7-day window would miss ~79% of the time.
  const days = solveWindowDays(12, '2025-09-01', TODAY);
  assert.ok(days > 7, `expected > 7 days, got ${days}`);
});

run('the solved window yields at least the target hit chance', () => {
  const postCount = 72;
  const join = '2023-01-01';
  const days = solveWindowDays(postCount, join, TODAY);
  const months = monthsBetween(join, TODAY);
  const lambda = postCount / months;
  const probability = 1 - Math.exp(-(lambda * days / 30));
  assert.ok(probability >= 0.85,
    `window ${days}d gives only ${(probability * 100).toFixed(1)}% hit chance`);
});

if (!summary('adaptive window')) process.exit(1);
