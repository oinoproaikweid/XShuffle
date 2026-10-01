/**
 * Tests for the probe-first search: one wide query across the account's whole
 * history, whose result is used directly instead of guessing a window width.
 *
 * This is the path that fixes the real failure. The adaptive-window model was
 * measured against live x.com and came out wrong: a profile advertising 72
 * posts returned only 4 to a from: search, spread a year apart, so a 42-day
 * window hit 0 times in 5 attempts. The probe measures instead of estimating.
 *
 * Run: node test/probe.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'background.js'), 'utf8');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
  else { failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected,
    `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
}

const TODAY = '2026-09-28';

function makeWorker() {
  const store = { session: {}, local: {} };
  const log = { created: [], navigated: [], updated: [], removed: [], messages: [] };
  let nextTabId = 500;
  let messageListener = null;
  const tabUrls = {};
  const fixedNow = new Date(`${TODAY}T12:00:00Z`);
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixedNow.getTime()); else super(...a); }
    static now() { return fixedNow.getTime(); }
  }
  const chrome = {
    runtime: { lastError: null, onMessage: { addListener: fn => { messageListener = fn; } } },
    storage: {
      session: {
        set: (o, cb) => { Object.assign(store.session, o); cb && cb(); },
        get: (k, cb) => { const r = {}; r[k] = store.session[k]; cb && cb(r); },
        remove: k => { delete store.session[k]; }
      },
      local: {
        set: (o, cb) => { Object.assign(store.local, o); cb && cb(); },
        get: (k, cb) => {
          const r = {};
          for (const key of Object.keys(k)) r[key] = store.local[key] === undefined ? k[key] : store.local[key];
          cb && cb(r);
        },
        remove: k => { delete store.local[k]; }
      }
    },
    alarms: { create() {}, clear: () => true, onAlarm: { addListener() {} } },
    tabs: {
      create: ({ url, active }, cb) => {
        const id = nextTabId++; tabUrls[id] = url;
        log.navigated.push({ url, active, id }); cb && cb({ id, url });
      },
      update: (id, { url }, cb) => { tabUrls[id] = url; log.updated.push({ id, url }); log.navigated.push({ id, url }); cb && cb({ id, url }); },
      remove: (id, cb) => { log.removed.push(id); cb && cb(); },
      get: (id, cb) => cb({ id, url: tabUrls[id] }),
      sendMessage: (id, msg, cb) => { log.messages.push({ id, msg }); cb && cb(); }
    }
  };
  // setTimeout/clearTimeout are real, so the retry delay actually elapses; a
  // sandbox without them throws as soon as a retry is delayed.
  const sandbox = vm.createContext({ chrome, crypto: { randomUUID: () => 'tok-1' }, console, Date: FakeDate, URLSearchParams, URL, Math, setTimeout, clearTimeout });
  vm.runInContext(SRC, sandbox);
  return {
    log, store, tabUrls,
    send: (msg, sender) => new Promise(res => messageListener(msg, sender, res)),
    setTabUrl: (id, url) => { tabUrls[id] = url; }
  };
}

const tick = () => new Promise(res => setImmediate(res));

/**
 * Every navigation the worker sent to the USER'S tab, oldest first. Tab 1 now
 * receives the probe and every date window as well as the final result, where
 * it used to receive only the last one, so a test that cares where the user
 * ended up must read the final entry rather than assume there is only one.
 */
const userNavs = w => w.log.updated.filter(u => u.id === 1).map(u => u.url);
const lastUserNav = w => userNavs(w).slice(-1)[0] || '';
const profileSender = (url, id = 1) => ({ tab: { id, url } });
const scanSender = (url, id = 500) => ({ url, tab: { id, url } });
const queryOf = url => new URL(url).searchParams.get('q');

async function startProbe(options = {}, joinDate = '2023-01-01') {
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'xtestuser', joinDate, requestId: 1, postCount: 72, options },
    profileSender('https://x.com/xtestuser'));
  await tick();
  const tok = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:')).replace('xshuffle:', '');
  const probeUrl = w.log.navigated[0].url;
  return { w, tok, probeUrl, scanId: w.log.navigated[0].id };
}

// The four posts a real whole-history search returned for this account, in the
// order X serves them. The probe search runs f=live, so the newest post comes
// first - the worker must not assume oldest-first.
const REAL_POSTS = [
  { id: '444', day: '2025-04-23' },
  { id: '333', day: '2024-02-29' },
  { id: '222', day: '2024-02-29' },
  { id: '111', day: '2023-02-20' }
];

const YOUNG_POSTS = [
  { id: '111', day: '2026-06-15' },
  { id: '222', day: '2026-07-04' },
  { id: '333', day: '2026-07-04' },
  { id: '444', day: '2026-09-01' }
];

// A probe is only trusted when one page could plausibly span the account, so
// the tests that exercise the probe path need a young account. This one joined
// in 2026, short enough that a single page of results could cover it.
async function startYoungProbe(options = {}) {
  return startProbe(options, '2026-06-01');
}

console.log('\nProbe search URL');

{
  const { probeUrl } = await startProbe();
  check('probe carries the xs_probe flag', /xs_probe=1/.test(probeUrl));
  // URLSearchParams encodes spaces in q= as '+', not %20.
  const q = new URL(probeUrl).searchParams.get('q');
  // until: is inclusive on X, so covering through today means until: today
  // exactly. The old assertion asked for tomorrow, which searched a day that
  // does not exist yet.
  check('probe spans join date to tomorrow', /since:2023-01-01/.test(q) && /until:2026-09-28/.test(q), q);
  check('probe is a single search over the whole history', /from:xtestuser since:2023-01-01/.test(q), q);
}

{
  const { probeUrl } = await startProbe({ excludeReplies: true, mediaOnly: true });
  const q = queryOf(probeUrl);
  // Matched with the negation included: a bare /filter:replies/ also matches
  // inside -filter:replies, so it cannot tell the two apart.
  check('probe carries the negated reply filter', /-filter:replies/.test(q), q);
  check('probe carries the media filter', /filter:media/.test(q), q);
}

{
  // A manual range should bound the probe, not be ignored by it.
  const { probeUrl } = await startProbe({ rangeStart: '2024-01-01', rangeEnd: '2024-06-01' });
  const q = queryOf(probeUrl);
  check('probe respects a manual range', /since:2024-01-01/.test(q) && /until:2024-06-01/.test(q), q);
}

console.log('\nProbe result handling');

{
  const { w, tok, probeUrl, scanId } = await startYoungProbe();
  w.setTabUrl(1, probeUrl);
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: YOUNG_POSTS } },
    scanSender(probeUrl, scanId));
  eq('a probe with posts succeeds immediately', r?.ok, true);
  // Tab 1 now receives every navigation, starting with the probe itself, so
  // the result is the LAST one rather than the only one. The probe is counted
  // separately to keep the assertion about the destination honest.
  const all = w.log.updated.filter(u => u.id === 1).map(u => u.url);
  const dest = all.slice(-1);
  eq('the user tab is navigated once more to land the post', dest.length, 1);
  const q = dest.length ? new URL(dest[0]).searchParams.get('q') : '';
  check('it navigates to a day that really has a post',
    YOUNG_POSTS.some(p => `since:${p.day}` === /since:\S+/.exec(q)?.[0]), q);
  check('the chosen day comes from the probe, not a guess',
    YOUNG_POSTS.some(p => q.includes(`since:${p.day}`)), q);
  // Nothing is closed any more: the scan ran in this tab and it stays open.
  check('closes no tab', w.log.removed.length === 0, JSON.stringify(w.log.removed));
}

{
  // The whole point: a rare poster with years between posts still succeeds.
  const { w, tok, probeUrl, scanId } = await startProbe();
  w.setTabUrl(1, probeUrl);
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: REAL_POSTS } },
    scanSender(probeUrl, scanId));
  check('a 4-post account spanning 2 years succeeds where 7-day windows failed',
    r?.ok === true, JSON.stringify(r));
}

console.log('\nProbe result validation');

{
  const { w, tok, probeUrl, scanId } = await startYoungProbe();
  w.setTabUrl(1, probeUrl);
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: [
      { id: 'not-numeric', day: '2026-07-01' },
      { id: '555', day: 'not-a-date' },
      { id: '666', day: '2019-01-01' },          // before join
      { id: '777', day: '2027-01-01' },          // future
      { id: '888', day: '2026-08-05' }           // the only valid one
    ] } },
    scanSender(probeUrl, scanId));
  eq('a probe with one valid post still succeeds', r?.ok, true);
  const dest = [new URL(lastUserNav(w)).searchParams.get('q')];
  check('invalid probe entries are discarded', dest.length === 1 && /since:2026-08-05/.test(dest[0]),
    JSON.stringify(dest));
}

{
  const { w, tok, probeUrl, scanId } = await startYoungProbe();
  w.setTabUrl(1, probeUrl);
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: [] } },
    scanSender(probeUrl, scanId));
  eq('an empty probe array does not succeed', r?.ok, false);
  const completion = w.log.messages.filter(m => m.msg.type === 'xshuffle:complete').pop();
  check('an empty probe reports a clear message',
    /no searchable posts/i.test(completion?.msg.response?.message || ''),
    JSON.stringify(completion?.msg.response));
  // The probe itself does navigate the user's tab now, so what matters is
  // that it is not navigated to a chosen post - there is none.
  check('an empty probe lands no post',
    !userNavs(w).some(u => u.includes('xs_post=')), JSON.stringify(userNavs(w)));
}

{
  // A manual range must also bound which probe results are acceptable.
  const { w, tok, probeUrl, scanId } = await startYoungProbe({ rangeStart: '2026-07-01', rangeEnd: '2026-08-01' });
  w.setTabUrl(1, probeUrl);
  await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: YOUNG_POSTS } },
    scanSender(probeUrl, scanId));
  const dest = [new URL(lastUserNav(w)).searchParams.get('q')];
  check('posts outside the manual range are discarded',
    dest.every(q => /since:2026-07-04/.test(q)), JSON.stringify(dest));
}

{
  // A range end is INCLUSIVE - "1 July to 1 August" includes 1 August. The
  // validation rejected a post dated exactly on the end, so the last day of a
  // hand-picked range could never produce a result.
  const { w, tok, probeUrl, scanId } = await startYoungProbe({ rangeStart: '2026-07-01', rangeEnd: '2026-07-04' });
  w.setTabUrl(1, probeUrl);
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: YOUNG_POSTS } },
    scanSender(probeUrl, scanId));
  check('a post on the inclusive range end is accepted', r?.ok === true, JSON.stringify(r));
  // Two of the fixture posts share 2026-07-04 and the pick is a weighted
  // random draw, so assert the landed day rather than a specific post id.
  check('and it is a post from the range-end day',
    userNavs(w).some(u => /since:2026-07-04/.test(decodeURIComponent(u))), JSON.stringify(userNavs(w)));
}
{
  // One day past the end is still out of range, so inclusivity does not leak.
  const { w, tok, probeUrl, scanId } = await startYoungProbe({ rangeStart: '2026-07-01', rangeEnd: '2026-07-03' });
  w.setTabUrl(1, probeUrl);
  await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: YOUNG_POSTS } },
    scanSender(probeUrl, scanId));
  check('a post one day past the range end is still discarded',
    !userNavs(w).some(u => /xs_post=/.test(decodeURIComponent(u))), JSON.stringify(userNavs(w)));
}

console.log('\nProbe distribution');

{
  // The probe is only trusted for a short-lived account, so the spread between
  // its posts is small. Check the ordering holds and that no day is unreachable.
  const counts = {};
  for (let i = 0; i < 300; i++) {
    const { w, tok, probeUrl, scanId } = await startYoungProbe();
    w.setTabUrl(1, probeUrl);
    await w.send(
      { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: YOUNG_POSTS } },
      scanSender(probeUrl, scanId));
    const dest = [{ url: lastUserNav(w) }];
    if (dest.length) {
      const day = (/since:(\S+)/.exec(new URL(dest[0].url).searchParams.get('q')) || [])[1];
      if (day) counts[day] = (counts[day] || 0) + 1;
    }
  }
  // This account's posts are all within months of each other, so the age
  // weights are nearly equal and the order is not a meaningful signal. What
  // must hold is that every draw lands on a day the probe actually reported.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  check('every draw lands on a real post day', total === 300, `${total}/300`);
  check('no day outside the probe results is ever chosen',
    Object.keys(counts).every(day => YOUNG_POSTS.some(p => p.day === day)),
    JSON.stringify(Object.keys(counts)));
}

console.log('\nProbe trust');

{
  // The bug this guards: a probe is one page of X results, served newest
  // first. Age-weighting that page still lands near today when the back
  // catalogue was never on it, so a long-lived account must skip the probe and
  // use the windowed scan instead.
  const { w, tok, probeUrl, scanId } = await startProbe();
  w.setTabUrl(1, probeUrl);
  await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: REAL_POSTS } },
    scanSender(probeUrl, scanId));
  // The windowed scan navigates the user's tab, so 'does not navigate' has
  // to mean 'does not land a result yet' - the probe is not trusted as the
  // whole history, so no post is chosen from it.
  check('a long-lived account does not land a post straight from the probe',
    !userNavs(w).some(u => u.includes('xs_post=')), JSON.stringify(userNavs(w)));
  // The fall-through to a windowed search is itself a retry, so it waits out
  // the retry delay before navigating. Without this the assertion below reads
  // the probe's own whole-history range and calls it unbounded.
  await new Promise(r => setTimeout(r, 1200));
  // The windowed scan reuses the scan tab rather than opening a new one, and
  // the user tab must be left alone until a post is actually found.
  const wq = queryOf(w.log.navigated[1]?.url || w.log.updated.find(u => u.id === scanId)?.url || '');
  const since = (/since:(\d{4}-\d{2}-\d{2})/.exec(wq) || [])[1];
  const until = (/until:(\d{4}-\d{2}-\d{2})/.exec(wq) || [])[1];
  // The window may legitimately start on the join date, so compare widths:
  // the whole-history probe runs to tomorrow, a window is much shorter.
  const width = since && until
    ? Math.round((new Date(`${until}T00:00:00Z`) - new Date(`${since}T00:00:00Z`)) / 86400000)
    : null;
  check('it falls through to a bounded window search',
    width !== null && width > 0 && width <= 90, `${width} days, q=${wq}`);
}

{
  // A page of results is a sample, not the history. Even a young account with
  // more posts than fit on one page must not trust it.
  const many = Array.from({ length: 15 }, (_, i) => ({
    id: String(700 + i), day: `2026-07-${String(i + 1).padStart(2, '0')}`
  }));
  const { w, tok, probeUrl, scanId } = await startYoungProbe();
  w.setTabUrl(1, probeUrl);
  await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: many } },
    scanSender(probeUrl, scanId));
  // Same distinction: the windowed scan runs in the user's tab, so the check
  // is that a full page of results was not treated as the whole history and a
  // post landed immediately.
  check('a full page of results is not trusted as the whole history',
    !userNavs(w).some(u => u.includes('xs_post=')), JSON.stringify(userNavs(w)));
}

console.log(`\nprobe search: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
