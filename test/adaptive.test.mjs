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

// ------------------------------------------------- one-page window ceiling
//
// X returns roughly one page of results, newest first. A window wide enough to
// hold many more posts than that does not widen the sample - it just returns
// the same newest page every time, so a wide window searches more to learn
// nothing new and shows the user the same posts. The ceiling below keeps a
// window to roughly the span one page can actually cover.
//
// These fail against the previous build, which allowed any window up to 90
// days regardless of how many posts that span would contain.

run('a prolific account gets a window that fits on one page', () => {
  // ~3000 posts over ~44 months is ~68/month, so a page of ~15 posts covers
  // roughly 7 days. Allowing 90 here returned one page's worth of the newest
  // posts from the last week, every single time.
  const days = solveWindowDays(3000, '2023-01-01', TODAY);
  assert.ok(days <= 15, `expected a page-sized window, got ${days} days`);
});

run('a very prolific account is not given a multi-week window', () => {
  // ~7000 posts over 44 months is ~160/month: one page is about 3 days.
  const days = solveWindowDays(7000, '2023-01-01', TODAY);
  assert.ok(days <= 7, `expected at most a week, got ${days} days`);
});

run('a moderate account is still capped to a page-sized window', () => {
  // ~500/month means a page covers about a day.
  const days = solveWindowDays(22000, '2023-01-01', TODAY);
  assert.ok(days <= 3, `expected a couple of days, got ${days} days`);
});

run('a slow account keeps a wide window - one page spans its whole posting rate', () => {
  // 72 posts over 44 months is under 2/month, so a page covers years. The cap
  // must not squeeze this into a narrow window that mostly misses.
  const days = solveWindowDays(72, '2023-01-01', TODAY);
  assert.ok(days >= 30, `expected a wide window for a rare poster, got ${days}`);
});

run('the page ceiling never returns less than a single day', () => {
  // A hyperactive account would divide to a fraction of a day.
  const days = solveWindowDays(5000000, '2023-01-01', TODAY);
  assert.ok(days >= 1, `expected at least one day, got ${days}`);
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
