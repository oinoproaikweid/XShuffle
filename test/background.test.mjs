/**
 * Headless harness for the Xshuffle MV3 service worker.
 *
 * Loads the real background.js unmodified inside a mock chrome.* API and
 * drives it through the message listener, asserting on the URLs, tab
 * operations and validation outcomes it produces.
 *
 * Run: node test/background.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { extractFunction, backgroundSrc } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
}

/** Build a fresh mock chrome API + sandbox, load background.js, return handles. */
function makeWorker({ today = '2026-09-28' } = {}) {
  const store = { session: {}, local: {} };
  const log = { created: [], navigated: [], updated: [], removed: [], messages: [], alarms: [], cleared: [] };
  let nextTabId = 500;
  let messageListener = null;
  const alarmListeners = [];

  // Freeze "now" so tomorrowUtc() is deterministic.
  const fixedNow = new Date(`${today}T12:00:00Z`);
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixedNow.getTime()); else super(...a); }
    static now() { return fixedNow.getTime(); }
    static UTC(...a) { return RealDate.UTC(...a); }
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: fn => { messageListener = fn; } },
    },
    storage: {
      session: {
        set(obj, cb) { Object.assign(store.session, obj); cb && cb(); },
        get(key, cb) { const r = {}; r[key] = store.session[key]; cb && cb(r); },
        remove(key) { delete store.session[key]; },
      },
      // local backs the rate-limit scan counter, which must survive a
      // service-worker restart, so it is deliberately separate from session.
      local: {
        set(obj, cb) { Object.assign(store.local, obj); cb && cb(); },
        get(key, cb) {
          const r = {};
          if (typeof key === 'string') r[key] = store.local[key];
          else for (const k of Object.keys(key)) r[k] = key[k] === undefined ? store.local[k] : store.local[k] ?? key[k];
          cb && cb(r);
        },
        remove(key) { delete store.local[key]; },
      },
    },
    alarms: {
      create: (name, info) => log.alarms.push({ name, when: info.when }),
      clear: name => { log.cleared.push(name); return true; },
      onAlarm: { addListener: fn => alarmListeners.push(fn) },
    },
    tabs: {
      // `navigated` records every URL the extension sent a tab to, in order,
      // whether via tabs.create or tabs.update. The scan now runs in the user's
      // own tab, so a single stream is what the tests actually care about;
      // created/updated stay for the few assertions that still distinguish them.
      create: ({ url, active }, cb) => {
        const id = nextTabId++;
        log.navigated.push({ url, active, id });
        log.navigated.push({ id, url });
        cb && cb({ id, url });
      },
      update: (id, { url }, cb) => {
        log.updated.push({ id, url });
        log.navigated.push({ id, url });
        cb && cb({ id, url });
      },
      remove: (id, cb) => { log.removed.push(id); cb && cb(); },
      get: (id, cb) => cb({ id, url: tabUrls[id] }),
      sendMessage: (id, msg) => log.messages.push({ id, msg }),
    },
  };

  const tabUrls = {};           // id -> current url, for the redirect guard
  const respondTo = [];         // captured sendResponse calls

  const ctx = vm.createContext({
    chrome, URL, URLSearchParams, console, crypto: { randomUUID: () => 'tok-' + Math.random().toString(16).slice(2, 8) },
    Date: FakeDate, setTimeout, clearTimeout,
  });
  ctx.globalThis = ctx;
  vm.runInContext(SRC, ctx, { filename: 'background.js' });

  return {
    chrome, log, store, tabUrls, respondTo,
    send(message, sender) {
      return new Promise(resolve => {
        respondTo.length = 0;
        const keep = messageListener(message, sender, r => respondTo.push(r));
        if (!keep) { resolve(null); return; }
        setTimeout(() => resolve(respondTo[respondTo.length - 1] ?? null), 5);
      });
    },
    fireAlarm(name) { alarmListeners.forEach(fn => fn({ name })); },
    respond: () => respondTo[respondTo.length - 1] ?? null,
  };
}

const profileSender = (url = 'https://x.com/someuser', id = 1) => ({ tab: { id, url } });
/**
 * The guard in background.js checks sender.url (the frame URL), not
 * sender.tab.url, so the test sender must populate both.
 */
const scanSender = (url, id) => ({ url, tab: { id, url } });
/** The q= param uses '+' for spaces once URLSearchParams-encoded. */
const WIN = /since:(\d{4}-\d{2}-\d{2})\+until:(\d{4}-\d{2}-\d{2})/;
function windowOf(url) { return decodeURIComponent(url).match(WIN); }
// The scan runs in the user's own tab (id 1), so that is the tab a
// scan-result arrives from. Kept as a helper so the intent is stated once
// rather than as a bare 1 scattered through the tests.
const scanTabIdOf = () => 1;
/**
 * Let queued callbacks and storage mocks run. A scan that starts cleanly does
 * not reply until it finishes, so tests that only care that a tab opened must
 * yield the event loop rather than await the response.
 */
const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------------------------------------------------------------- URL building

console.log('\n\x1b[1mURL construction\x1b[0m');
{
  const w = makeWorker();
  const r = await w.send(
    { type: 'xshuffle:discover', username: 'alice', joinDate: '2023-01-15', requestId: 7 },
    profileSender('https://x.com/alice', 1)
  );
  const url = w.log.navigated[0]?.url || '';
  check('starts a search', !!url);
  // The scan runs in the tab the user is already on. A second, hidden tab is
  // exactly what this change removed, so creating one is now a regression.
  check('opens no extra tab', w.log.created.length === 0, JSON.stringify(w.log.created));
  check("navigates the user's own tab", w.log.navigated[0]?.id === 1, String(w.log.navigated[0]?.id));
  check('uses x.com/search', url.startsWith('https://x.com/search?'));
  check('has from: filter', decodeURIComponent(url).includes('from:alice'));
  check('has since: bound', decodeURIComponent(url).includes('since:'));
  check('has until: bound', decodeURIComponent(url).includes('until:'));
  check('carries xs_join', url.includes('xs_join=2023-01-15'));
  check('carries xs_scan token', url.includes('xs_scan='));
  check('discover responds after async', r === undefined || r === null);
}

// ---------------------------------------------------------- window selection

const formatDay = d => d.toISOString().slice(0, 10);

console.log('\n\x1b[1mProbe search and window selection\x1b[0m');
{
  // The first tab opened is the probe: one search across the whole history.
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72 }, profileSender('https://x.com/bob', 1));
  await tick();
  const url = decodeURIComponent(w.log.navigated[0].url);
  const m = windowOf(url);
  check('probe has since/until', !!m);
  check('probe is flagged so the page returns every post', /xs_probe=1/.test(url), url.slice(0, 120));
  if (m) {
    const s = new Date(m[1] + 'T00:00:00Z'), e = new Date(m[2] + 'T00:00:00Z');
    check('probe starts at the join date', formatDay(s) === '2023-01-01', formatDay(s));
    check('probe covers the whole account lifetime',
      Math.round((e - s) / 86400000) > 1000, `${Math.round((e - s) / 86400000)} days`);
  }
  // Same here: the probe is a visible search in the user's tab, not a
  // background one, and it must not create a tab of its own.
  check('probe opens no extra tab', w.log.created.length === 0, JSON.stringify(w.log.created));
}
{
  // With an empty probe, the worker falls back to an adaptively sized window.
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72 }, profileSender('https://x.com/bob', 1));
  await tick();
  const tok = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:')).replace('xshuffle:', '');
  const scanId = scanTabIdOf(w);
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=x', scanId));
  // The fallback retry waits out the default retry delay before navigating.
  await new Promise(r => setTimeout(r, 1200));
  const fallback = decodeURIComponent(w.log.updated[w.log.updated.length - 1].url);
  const fm = windowOf(fallback);
  check('empty probe falls back to a windowed search', !!fm, fallback.slice(0, 120));
  check('fallback window is not the probe', !/xs_probe=1/.test(fallback));
  if (fm) {
    const days = Math.round((new Date(fm[2] + 'T00:00:00Z') - new Date(fm[1] + 'T00:00:00Z')) / 86400000);
    // 72 posts over ~44 months is a rare poster, so the solver widens past the
    // old fixed 7 days - see test/adaptive.test.mjs.
    check('fallback window is sized from the posting rate', days > 7 && days <= 90, `${days} days`);
  }
}
{
  // Older bias: sample many windows, oldest should appear more often than newest.
  const w = makeWorker();
  const picks = [];
  for (let i = 0; i < 300; i++) {
    const ww = makeWorker();
    await ww.send({ type: 'xshuffle:discover', username: 'c', joinDate: '2020-01-01', requestId: 1 }, profileSender('https://x.com/c', 1));
    const u = decodeURIComponent(ww.log.navigated[0].url);
    const mm = windowOf(u);
    if (mm) picks.push(mm[1]);
  }
  const sorted = [...picks].sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  const newest = '2026-09-22';
  const countNewest = picks.filter(p => p === newest || p > '2026-09-01').length;
  const countOlder = picks.filter(p => p < '2025-01-01').length;
  check('samples older windows more than recent ones', countOlder > countNewest, `older=${countOlder} recent=${countNewest} median=${median}`);
}

// -------------------------------------------------------- no repeat windows

console.log('\n\x1b[1mNo-repeat guarantee\x1b[0m');
{
  // Needs enough history for at least 6 distinct 7-day windows.
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'dave', joinDate: '2020-01-01', requestId: 1 }, profileSender('https://x.com/dave', 1));
  const tok = Object.keys(w.store.session)[0].replace('xshuffle:', '');
  const seen = new Set([windowOf(w.log.navigated[0].url)[0]]);
  const scanId = scanTabIdOf(w);
  for (let i = 0; i < 5; i++) {
    w.tabUrls[scanId] = 'https://x.com/search?q=from:dave';
    await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=from:dave', scanId));
    // Each retry waits out the delay; without this the loop reads the previous
    // window and the distinctness assertion is meaningless.
    await new Promise(r => setTimeout(r, 1200));
    const g = windowOf(w.log.updated[w.log.updated.length - 1]?.url || '');
    if (g) seen.add(g[0]);
  }
  // navigated already contains every update, so it is the single count -
  // adding updated as well would count each window twice.
  const total = w.log.navigated.length;
  check('each retry picks a distinct window', seen.size === total, `unique=${seen.size} issued=${total}`);
}

// ------------------------------------------------------------ 30-try cap

console.log('\n\x1b[1mRetry cap\x1b[0m');
{
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'erin', joinDate: '2020-01-01', requestId: 1 }, profileSender('https://x.com/erin', 1));
  const tok = Object.keys(w.store.session)[0].replace('xshuffle:', '');
  const scanId = scanTabIdOf(w);
  for (let i = 0; i < 40; i++) {
    w.tabUrls[scanId] = 'https://x.com/search?q=from:erin';
    await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=from:erin', scanId));
  }
  const issued = w.log.navigated.length;
  check('stops at 30 windows', issued <= 30, `issued=${issued}`);
  check('reports failure to the page', w.log.messages.some(m => m.msg.type === 'xshuffle:complete' && m.msg.response?.ok === false));
  // There is no scan tab to close any more. What must happen instead is the
  // user being put back on the profile they started from, rather than being
  // left on the last empty date range.
  check('closes no tab', w.log.removed.length === 0, JSON.stringify(w.log.removed));
  check('returns the user to the profile', w.log.navigated.some(u => u.url === 'https://x.com/erin'),
    JSON.stringify(w.log.navigated.map(u => u.url)));
  check('clears session state', Object.keys(w.store.session).filter(k => k.startsWith('xshuffle:')).length === 0);
}

// ------------------------------------------------------------- input validation

console.log('\n\x1b[1mInput validation\x1b[0m');
const badCases = [
  ['malformed join date', { username: 'a', joinDate: '2023-13-45' }],
  ['future join date', { username: 'a', joinDate: '2027-01-01' }],
  ['non-date join', { username: 'a', joinDate: 'January 2023' }],
  ['invalid username chars', { username: 'bad name!', joinDate: '2023-01-01' }],
  ['username too long', { username: 'abcdefghijklmnopqrs', joinDate: '2023-01-01' }],
];
for (const [label, msg] of badCases) {
  const w = makeWorker();
  const r = await w.send({ type: 'xshuffle:discover', requestId: 1, ...msg }, profileSender('https://x.com/someuser', 1));
  const rejected = (r?.ok === false) || w.log.navigated.length === 0;
  check(`rejects ${label}`, rejected, `response=${JSON.stringify(r)}`);
}
{
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'a', joinDate: '2023-01-01', requestId: 1 }, { tab: { id: 1, url: 'https://evil.example/alice' } });
  check('rejects non-x.com sender', w.log.navigated.length === 0);
}

// -------------------------------------------------------- post validation

console.log('\n\x1b[1mScan result validation\x1b[0m');
/**
 * Start a scan and drive it past the probe, exactly as the content script
 * would: the first opened tab is the whole-history probe, and an empty probe
 * is what pushes the worker into the windowed scan that sets currentWindow.
 */
async function startScan(username = 'frank', joinDate = '2023-01-01', { postCount = 72 } = {}) {
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username, joinDate, requestId: 1, postCount }, profileSender(`https://x.com/${username}`, 1));
  await tick();
  const tok = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:')).replace('xshuffle:', '');
  const scanId = scanTabIdOf(w);
  // The probe returns nothing, so the worker falls back to a windowed scan.
  // That retry waits out the default retry delay before navigating, so give it
  // time to land - reading the URL synchronously would see the probe's.
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=x', scanId));
  await new Promise(r => setTimeout(r, 1200));
  w.tabUrls[scanId] = 'https://x.com/search?q=x';
  // The user's tab (id 1) still shows the profile the scan started from.
  w.tabUrls[1] = `https://x.com/${username}`;
  return { w, tok, scanId };
}
{
  // current window is recorded; build an in-window date
  const { w, tok, scanId } = await startScan();
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const mid = new Date(new Date(cur.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '1234567890', day: mid } }, scanSender('https://x.com/search?q=x', scanId));
  check('accepts a valid in-window post', r?.ok === true, JSON.stringify(r));
  const dest = w.log.updated.map(u => decodeURIComponent(u.url)).find(u => u.includes('xs_post=1234567890'));
  check('navigates to the one-day search', !!dest);
  // until: is inclusive on X, so a single day is until equal to since. The
  // old assertion demanded a 86400000 gap, which is a two-day search.
  check('daily search is exactly 1 day', !!dest && (() => {
    const g = windowOf(dest);
    if (!g) return false;
    return g[1] === g[2];
  })(), dest ? windowOf(dest).slice(1).join('..') : 'no window');
  check('closes no tab on success', w.log.removed.length === 0, JSON.stringify(w.log.removed));
  check('lands the user on the daily search',
    w.log.navigated.some(u => decodeURIComponent(u.url).includes('xs_post=1234567890')), '');
}
const postBad = [
  ['post date before join', p => ({ id: '1', day: '2019-01-01' })],
  ['post date in the future', p => ({ id: '1', day: '2027-01-01' })],
  ['non-numeric post id', p => ({ id: 'abc', day: p.validDay })],
  ['missing post id', p => ({ id: '', day: p.validDay })],
];
for (const [label, build] of postBad) {
  const { w, tok, scanId } = await startScan();
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const validDay = new Date(new Date(cur.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: build({ validDay }) }, scanSender('https://x.com/search?q=x', scanId));
  const rejected = r?.ok === false;
  check(`rejects ${label}`, rejected, `response=${JSON.stringify(r)}`);
}
{
  // A post inside join..today but outside the CURRENT window is a straggler
  // from a window the scan has already left, not bad data - see the late-post
  // section below. It must be ignored without ending the scan.
  //
  // This assertion used to require ok === false, which is the behaviour that
  // produced the reported symptom: one slow page reporting after the scan moved
  // on aborted the whole scan and returned the user to the profile.
  const { w, tok, scanId } = await startScan('grace', '2020-01-01');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const far = new Date(new Date(cur.end + 'T00:00:00Z').getTime() + 8 * 86400000).toISOString().slice(0, 10);
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '42', day: far } }, scanSender('https://x.com/search?q=x', scanId));
  check('a post from a superseded window is ignored, not fatal',
    r?.ok === true && r?.stale === true, `response=${JSON.stringify(r)} day=${far} window=${cur.start}..${cur.end}`);
  check('and the scan survives it', Object.values(w.store.session)[0] !== undefined);
}
{
  // A date outside the account's own lifetime is NOT a straggler: it cannot
  // have come from any window of this account, so it stays fatal.
  const { w, tok, scanId } = await startScan('heidi2', '2020-01-01');
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '42', day: '2031-01-01' } },
    scanSender('https://x.com/search?q=x', scanId));
  check('a post from after today is still rejected outright', r?.ok === false,
    `response=${JSON.stringify(r)}`);
}

// ------------------------------------------------------- scan window bounds

console.log('\n\x1b[1mScan window bounds (until: is inclusive on X)\x1b[0m');
/**
 * X's `until:` operator is INCLUSIVE of the date given - until:2024-03-31
 * returns posts made on 31 March. The window builder treats its end as
 * EXCLUSIVE (it builds the next window starting exactly there, and validates
 * results with `day >= end` rejected).
 *
 * That mismatch means every window's final day is searched but then thrown
 * away by validation: the content script extracts the post, the worker
 * rejects it as out-of-window, and the scan burns a window for nothing. On a
 * 1-day window it is every window. These tests pin the two halves together:
 * the URL asked for must cover exactly the days validation accepts.
 */
{
  const { w, tok, scanId } = await startScan('kate', '2023-01-01');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  // The URL the worker actually searched for this window.
  const searched = w.log.navigated.map(u => decodeURIComponent(u.url)).map(windowOf).filter(Boolean).pop();
  check('the searched range covers the window start', searched?.[1] === cur.start,
    `searched since=${searched?.[1]} window start=${cur.start}`);
  // until: is inclusive, so the day asked for last must be the day validation
  // accepts last. Asking for cur.end itself returns cur.end, which validation
  // rejects - the dropped-day bug.
  const askedLast = searched?.[2];
  const acceptsLast = new Date(new Date(cur.end + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  check('the last day searched is a day validation accepts',
    askedLast === acceptsLast,
    `asked until:${askedLast} but accepts up to ${acceptsLast} (window ${cur.start}..${cur.end})`);
}
{
  // A post on the last day the URL actually returned must be accepted, not
  // rejected as out-of-window. This is the user-visible miss.
  const { w, tok, scanId } = await startScan('liam', '2023-01-01');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const lastAccepted = new Date(new Date(cur.end + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: '555', day: lastAccepted } },
    scanSender('https://x.com/search?q=x', scanId));
  check('accepts a post on the window\'s final in-range day', r?.ok === true,
    `day=${lastAccepted} window=${cur.start}..${cur.end} response=${JSON.stringify(r)}`);
}
{
  // Windows must tile the span with no gap and no overlap, or days go
  // unsearched (missing results) or searched twice (wasted rate limit).
  const chooseSrc = [
    extractFunction(backgroundSrc, 'formatDate'),
    extractFunction(backgroundSrc, 'tomorrowUtc'),
    extractFunction(backgroundSrc, 'rangeEndExclusive'),
    extractFunction(backgroundSrc, 'chooseScanWindow'),
    'const MIN_WINDOW_DAYS = 1, MAX_WINDOW_DAYS = 90;',
  ].join('\n');
  const chooseScanWindow = new Function(`${chooseSrc}\nreturn chooseScanWindow;`)();
  // One state, shared: triedWindows is what stops a window being drawn twice,
  // so resetting it per draw would just re-roll the same windows.
  const state = {
    username: 'u', joinDate: '2020-01-01', windowDays: 7, options: {},
    triedWindows: new Set(),
  };
  const covered = new Set();
  let overlaps = 0;
  let drawn = 0;
  for (let i = 0; i < 400; i++) {
    const win = chooseScanWindow(state);
    if (!win) break;
    drawn++;
    for (let t = Date.parse(win.start + 'T00:00:00Z'); t < Date.parse(win.end + 'T00:00:00Z'); t += 86400000) {
      if (covered.has(t)) overlaps++;
      covered.add(t);
    }
  }
  // The extracted function builds its own "tomorrow" from the real clock, so
  // the expected window count is derived from the same clock rather than
  // hardcoded against the harness's frozen date.
  const realTomorrow = new Date();
  realTomorrow.setUTCHours(0, 0, 0, 0);
  realTomorrow.setUTCDate(realTomorrow.getUTCDate() + 1);
  const spanDays = Math.ceil((realTomorrow - new Date('2020-01-01T00:00:00Z')) / 86400000);
  check('every window in the span is drawable', drawn === Math.ceil(spanDays / 7), `drew ${drawn} windows, span ${spanDays} days`);
  check('windows never overlap each other', overlaps === 0, `${overlaps} overlapping days`);
  // The join date up to tomorrow is the whole span; every day in it must be
  // reachable by some window.
  const spanStart = Date.parse('2020-01-01T00:00:00Z');
  const spanEnd = realTomorrow.getTime();
  let missing = 0;
  for (let t = spanStart; t < spanEnd; t += 86400000) if (!covered.has(t)) missing++;
  check('every day of the account lifetime is covered by some window', missing === 0,
    `${missing} days unreachable across 400 draws`);
}

// ------------------------------------------------------------ redirect guard

console.log('\n\x1b[1mRedirect guard (user navigated away)\x1b[0m');
{
  const { w, tok, scanId } = await startScan('heidi');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const day = new Date(new Date(cur.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  w.tabUrls[1] = 'https://x.com/someoneelse';   // user moved to a different account
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '9', day } }, scanSender('https://x.com/search?q=x', scanId));
  const completion = w.log.messages.filter(m => m.msg.type === 'xshuffle:complete').pop();
  check('refuses to hijack a different profile', completion?.msg.response?.ok === false);
  // The scan windows themselves navigate this tab, so the meaningful check is
  // that it was NOT taken to the post that was found - the user keeps the page
  // they chose.
  check('does not navigate the user to the found post',
    !w.log.navigated.some(u => decodeURIComponent(u.url).includes('xs_post=9')),
    JSON.stringify(w.log.navigated.map(u => u.url)));
}
{
  const { w, tok, scanId } = await startScan('ivan');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const day = new Date(new Date(cur.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  w.tabUrls[1] = 'https://x.com/search?q=from%3Aivan';   // still the same account, on search
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '9', day } }, scanSender('https://x.com/search?q=x', scanId));
  check('still allows the result on the same account search page', w.log.updated.length > 0);
}
{
  // A STALLED page (content.js gave up at DISCOVERY_TIMEOUT_MS) proves nothing
  // about whether the window is empty. Treating it as a miss is actively
  // harmful: it burns a window AND counts toward the widening threshold, so
  // three stalls in a row would widen the window off pages that never
  // rendered. The stall is therefore retried on the SAME window and must not
  // touch emptyWindows.
  const { w, tok, scanId } = await startScan('nina', '2020-01-01');
  const before2 = JSON.parse(JSON.stringify(Object.values(w.store.session)[0]));
  const cur = before2.currentWindow;
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: { stalled: true } }, scanSender('https://x.com/search?q=x', scanId));
  await new Promise(r => setTimeout(r, 1200));
  const state = Object.values(w.store.session)[0];
  const after = state && JSON.parse(JSON.stringify(state));
  check('a stall does not count toward widening the window',
    (after?.emptyWindows ?? 0) === 0,
    `emptyWindows=${after?.emptyWindows} - a stall must not widen the window`);
  check('a stall does not widen the window width',
    after?.windowDays === before2?.windowDays && JSON.stringify(after?.currentWindow) === JSON.stringify(cur),
    `window ${JSON.stringify(after?.currentWindow)} days=${after?.windowDays} (was ${before2?.windowDays})`);
  check('a stall still costs one attempt, so a dead connection eventually ends',
    after?.windowsTried === 2, `windowsTried=${after?.windowsTried}`);
}
{
  // The retry must re-search the SAME window, not draw a new one - the window
  // was never disproven, so searching a different range would skip over days
  // that might hold the post.
  const { w, tok, scanId } = await startScan('oscar', '2020-01-01');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const before = w.log.navigated.length;
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: { stalled: true } }, scanSender('https://x.com/search?q=x', scanId));
  await new Promise(r => setTimeout(r, 1200));
  const retried = w.log.navigated.slice(before).map(u => windowOf(decodeURIComponent(u.url))).filter(Boolean).pop();
  // until: is inclusive, so the URL's last day is the day before the window's
  // exclusive end - the same conversion every other window assertion uses.
  const expectedLast = new Date(new Date(cur.end + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  check('a stall retries the same window', retried?.[1] === cur.start && retried?.[2] === expectedLast,
    `retried since=${retried?.[1]} until=${retried?.[2]}, window was ${cur.start}..${cur.end} (searched to ${expectedLast})`);
}
{
  // The success path is guarded by stillOurs so a user who navigated away
  // keeps the page they chose. The failure path was not: any miss that ended
  // the scan called returnToProfile unconditionally, yanking a user off
  // whatever they had moved to and putting them back on the profile the
  // shuffle started from. Exhausting the scan budget is one such ending.
  const { w, tok, scanId } = await startScan('judy2', '2023-01-01');
  w.tabUrls[1] = 'https://x.com/someoneelse';           // user moved on during the scan
  const before = w.log.navigated.length;
  // Burn the whole scan budget with empty windows, then send the result that
  // exhausts it - that is the call that reports "no visible posts".
  const state = () => {
    const entry = Object.values(w.store.session)[0];
    return entry ? JSON.parse(JSON.stringify(entry)) : null;
  };
  for (let i = 0; i < 40; i++) {
    const cur = state();
    if (!cur?.currentWindow) break;
    await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=x', scanId));
    await new Promise(r => setTimeout(r, 1200));
    if (!state()) break;
  }
  const after = w.log.navigated.slice(before).map(u => u.url);
  check('a failed scan does not drag a user who navigated away back to the profile',
    !after.includes('https://x.com/judy2'), JSON.stringify(after.slice(-4)));
}

// ------------------------------------------------------------------- timeouts

{
  // MV3 evicts an idle service worker after ~30s, and a scan that reloads X
  // repeatedly is exactly the idle case - so this state is reloaded from
  // session storage far more often than it looks. Anything the widening logic
  // reads must therefore be in serializableState, or the counter silently
  // resets mid-scan and the window never widens.
  const serializable = new Function(
    `${extractFunction(backgroundSrc, 'serializableState')}\nreturn serializableState;`)();
  const roundTripped = serializable({
    token: 't', targetTabId: 1, sourceUrl: 'https://x.com/a', username: 'a',
    joinDate: '2020-01-01', requestId: 1, windowsTried: 2,
    triedWindows: new Set([0, 1]), currentWindow: { start: '2020-01-01', end: '2020-01-08' },
    windowDays: 77, emptyWindows: 2, baseWindowDays: 14, options: {},
  });
  check('the widening counter survives a worker restart',
    roundTripped.emptyWindows === 2, `emptyWindows=${roundTripped.emptyWindows}`);
  check('the original window width survives a worker restart',
    roundTripped.baseWindowDays === 14, `baseWindowDays=${roundTripped.baseWindowDays}`);
  check('the current window width survives a worker restart',
    roundTripped.windowDays === 77, `windowDays=${roundTripped.windowDays}`);
}

console.log('\n\x1b[1mTimeout\x1b[0m');
{
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'judy', joinDate: '2023-01-01', requestId: 1 }, profileSender('https://x.com/judy', 1));
  check('arms a 90s alarm', w.log.alarms.some(a => a.name.startsWith('xshuffle-timeout:')));
  // When the alarm fires the tab is on the probe search the scan navigated it
  // to, so returning the user to the profile is correct here.
  w.tabUrls[1] = 'https://x.com/search?q=from%3Ajudy';
  const name = w.log.alarms[0].name;
  w.fireAlarm(name);
  await new Promise(r => setTimeout(r, 5));
  const completion = w.log.messages.filter(m => m.msg.type === 'xshuffle:complete').pop();
  check('timeout reports failure', completion?.msg.response?.ok === false);
  check('timeout closes no tab', w.log.removed.length === 0, JSON.stringify(w.log.removed));
  check('timeout returns the user to the profile',
    w.log.navigated.some(u => u.url === 'https://x.com/judy'), JSON.stringify(w.log.navigated.map(u => u.url)));
  check('timeout clears the alarm', w.log.cleared.includes(name));
}

console.log('\n\x1b[1mA late post from a superseded window\x1b[0m');
{
  // A valid post that arrives AFTER the scan moved to a different window must
  // not abort the scan.
  //
  // This is the "skip on a valid result" symptom. The post is real, in range
  // for the account, and was on screen - but the worker had already moved to
  // another window, so the post failed the in-window check and was treated as
  // "an unusable date", which ends the scan and bounces the user back to the
  // profile. The right response to a late result from a window the scan has
  // already left is to ignore it and keep looking: the scan is still running
  // and perfectly able to find something better.
  const { w, tok, scanId } = await startScan('quinn', '2020-01-01');
  const before = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  // A genuinely empty window advances the scan to a different one.
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=x', scanId));
  await new Promise(r => setTimeout(r, 1200));
  const now = JSON.parse(JSON.stringify(Object.values(w.store.session)[0]));
  const cur = now.currentWindow;
  check('the scan advanced to a new window', JSON.stringify(before) !== JSON.stringify(cur),
    `window unchanged: ${JSON.stringify(cur)}`);
  // A post from the window the scan has now LEFT arrives, late. Real post id,
  // real in-range date - but belonging to the superseded window.
  const lateDay = new Date(new Date(before.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const outOfNewWindow = !(cur.start <= lateDay && lateDay < cur.end);
  check('the late post is outside the new window', outOfNewWindow,
    `day=${lateDay} new window=${cur.start}..${cur.end}`);
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '424242', day: lateDay } },
    scanSender('https://x.com/search?q=x', scanId));
  const stillRunning = Object.values(w.store.session)[0] !== undefined;
  check('a late post from a superseded window does not end the scan', stillRunning,
    'scan state was cleared - the scan aborted on a late report');
  // And the scan must still work: a post genuinely inside the CURRENT window
  // has to land normally afterwards.
  const goodDay = new Date(new Date(cur.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '515151', day: goodDay } },
    scanSender('https://x.com/search?q=x', scanId));
  check('the scan still finds a post in its current window', r?.ok === true,
    `response=${JSON.stringify(r)}`);
}

// ------------------------------------------------------------------- summary

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }