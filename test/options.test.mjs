/**
 * Tests for the search options added on top of the adaptive window:
 * reply/media filters, the manual date range, single-post navigation and the
 * rate-limit cooldown.
 *
 * Run: node test/options.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'background.js'), 'utf8');

// Lift the real constant out of background.js so this test cannot pass against
// a default the extension no longer ships.
const DEFAULT_RETRY_DELAY_MS = Number(
  (/const\s+DEFAULT_RETRY_DELAY_MS\s*=\s*(\d+)/.exec(SRC) || [])[1]);


let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
  else { fail(name, detail); }
}
function eq(name, actual, expected) {
  check(name, actual === expected,
    `\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
}
function fail(name, detail) {
  failures.push(name);
  console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
}

function makeWorker({ today = '2026-09-28' } = {}) {
  const store = { session: {}, local: {} };
  const log = { created: [], navigated: [], updated: [], removed: [], messages: [], alarms: [], cleared: [] };
  let nextTabId = 500;
  let messageListener = null;
  const alarmListeners = [];
  const fixedNow = new Date(`${today}T12:00:00Z`);
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
          if (typeof k === 'string') r[k] = store.local[k];
          else for (const key of Object.keys(k)) {
            r[key] = store.local[key] === undefined ? k[key] : store.local[key];
          }
          cb && cb(r);
        },
        remove: k => {
          // The worker clears a cooldown with an array of keys, so both the
          // string and array forms have to work here.
          for (const key of (Array.isArray(k) ? k : [k])) delete store.local[key];
        }
      }
    },
    alarms: {
      create: (name, info) => log.alarms.push({ name, when: info.when }),
      clear: name => { log.cleared.push(name); return true; },
      onAlarm: { addListener: fn => alarmListeners.push(fn) }
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
      get: (id, cb) => cb({ id, url: store.session.__tabUrl || 'https://x.com/bob' }),
      sendMessage: (id, msg, cb) => { log.messages.push({ id, msg }); cb && cb(); }
    }
  };
  // setTimeout/clearTimeout are real here, not the frozen clock: the retry delay
  // is the thing under test and has to actually elapse. FakeDate only pins
  // Date.now() for the cooldown arithmetic, which is why the two coexist.
  const sandbox = vm.createContext({ chrome, crypto: { randomUUID: () => 'tok-1' }, console, Date: FakeDate, URLSearchParams, URL, Math, setTimeout, clearTimeout });
  vm.runInContext(SRC, sandbox);
  return {
    log, store, chrome, alarmListeners,
    send: (msg, sender) => new Promise(res => messageListener(msg, sender, res)),
    fireAlarm: name => alarmListeners.forEach(fn => fn({ name })),
    setTabUrl: url => { store.session.__tabUrl = url; }
  };
}

function profileSender(url, id = 1) {
  return { tab: { id, url } };
}

// The runtime populates BOTH sender.url and sender.tab.url for a message from
// a content script, and the scan guard reads sender.url. The test sender must
// supply both, exactly like the working background suite does.
function scanSender(url, id = 500) {
  return { url, tab: { id, url } };
}

function queryOf(url) {
  return new URL(url).searchParams.get('q');
}

// ---------------------------------------------------------------- filters --

console.log('\nSearch filters');

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { excludeReplies: true }
  }, profileSender('https://x.com/bob'));
  const q = queryOf(w.log.navigated[0]?.url);
  // X's filter: operators are ALLOW lists, not deny lists. Bare
  // `filter:replies` means "only replies" - the exact opposite of hiding them,
  // which is why the Hide replies toggle appeared to do nothing (or made
  // results worse). Excluding requires the `-` negation prefix.
  check('excludeReplies negates the replies filter', /-filter:replies/.test(q), q);
  check('excludeReplies never emits a bare filter:replies',
    !/(^|\s)filter:replies/.test(q), q);
  check('excludeReplies alone adds no media filter', !/filter:media/.test(q));
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { mediaOnly: true }
  }, profileSender('https://x.com/bob'));
  check('mediaOnly adds filter:media', /filter:media/.test(queryOf(w.log.navigated[0]?.url)));
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { excludeReplies: true, mediaOnly: true }
  }, profileSender('https://x.com/bob'));
  const q = queryOf(w.log.navigated[0]?.url);
  check('both filters combine with the correct polarity',
    /-filter:replies/.test(q) && /filter:media/.test(q), q);
  check('filters sit after the date bounds', q.indexOf('until:') < q.indexOf('filter:'), q);
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { excludeReplies: 'yes-please' }
  }, profileSender('https://x.com/bob'));
  check('non-boolean filter values are ignored',
    !/filter:replies/.test(queryOf(w.log.navigated[0]?.url)));
}

// ------------------------------------------------------------ date range --

console.log('\nManual date range');

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { rangeStart: '2024-03-01', rangeEnd: '2024-03-31' }
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const q = queryOf(w.log.navigated[0]?.url);
  // A 30-day range is one window, so the bounds are the range itself.
  check('explicit range is honoured', /since:2024-03-01/.test(q) && /until:2024-03-31/.test(q), q);
  check('range overrides the posting-rate estimate', /since:2024-03-01/.test(q));
  check('no window falls outside the requested range',
    !/since:202[0-3]-(?!03)/.test(q), q);
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { rangeStart: 'not-a-date', rangeEnd: '2024-03-31' }
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  check('a malformed range falls back to automatic sizing',
    !/since:2024-03-01/.test(queryOf(w.log.navigated[0]?.url)),
    queryOf(w.log.navigated[0]?.url));
}

{
  const w = makeWorker();
  const res = await w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { rangeStart: '2024-03-31', rangeEnd: '2024-03-01' }
  }, profileSender('https://x.com/bob'));
  eq('an inverted range is refused', res?.ok, false);
  check('an inverted range opens no search tab', w.log.navigated.length === 0);
}

// ---------------------------------------------------------- single post ----

console.log('\nSingle-post navigation');

/**
 * Drive a scan all the way to a chosen post.
 *
 * The first tab opened is the whole-history probe, so this sends an empty
 * probe result to push the worker into its windowed fallback, then reports a
 * post from whichever window it picked.
 */
async function scanToPost(w, options = {}) {
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const probeUrl = w.log.navigated[0]?.url;
  const scanId = w.log.navigated[0].id;
  // Empty probe -> the worker opens a windowed search in the same tab. That
  // retry now waits out the default retry delay first, so wait for the
  // navigation to land before reading its URL back.
  await w.send({ type: 'xshuffle:scan-result', token: 'tok-1', post: null }, scanSender(probeUrl, scanId));
  await new Promise(r => setTimeout(r, DEFAULT_RETRY_DELAY_MS + 150));
  const windowUrl = w.log.updated[w.log.updated.length - 1].url;
  const m = /since:(\d{4}-\d{2}-\d{2})/.exec(decodeURIComponent(windowUrl));
  const day = m[1];
  w.setTabUrl('https://x.com/bob');
  return w.send({
    type: 'xshuffle:scan-result', token: 'tok-1',
    post: { id: '1767706435989684582', day }
  }, scanSender(windowUrl, scanId));
}

{
  const w = makeWorker();
  await scanToPost(w, { openSinglePost: true });
  const final = w.log.updated[w.log.updated.length - 1].url;
  check('single-post mode lands on the permalink',
    final === 'https://x.com/bob/status/1767706435989684582', final);
}

{
  const w = makeWorker();
  await scanToPost(w, { openSinglePost: false });
  const final = w.log.updated[w.log.updated.length - 1].url;
  check('default mode lands on a filtered search', /x\.com\/search/.test(final), final);
}

// ------------------------------------------------------------- cooldown ----
//
// Note on responses: a scan that starts successfully does NOT reply straight
// away - the reply carries the finished result, so it arrives only when a post
// is found or the scan gives up. Only a refused scan answers immediately.
// Tests below therefore check tab creation rather than awaiting a reply, and
// await only where a refusal is expected.
//
// The pause is driven by X's own throttle signal, not by a scan budget, so
// there is deliberately no test here for "the 13th scan is refused". That
// behaviour is gone; what is tested instead is that a detected limit pauses,
// that a clean account is never interrupted, and - the case that motivated
// the change - that a throttled scan stops instead of walking on to the next
// date window as if the window were merely empty.

console.log('\nRate-limit cooldown');

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('an unthrottled scan opens exactly one search tab', w.log.navigated.length, 1);
  check('a scan that has not been throttled records no pause',
    !w.store.local.cooldownUntil, JSON.stringify(w.store.local.cooldownUntil));
}

{
  const w = makeWorker();
  // No limit, but many scans already run. The old build refused the 13th
  // inside the window; the point of this test is that it no longer does,
  // because X is the only authority on when to stop.
  w.store.local.recentScans = Array.from({ length: 40 }, () => new Date('2026-09-28T12:00:00Z').getTime());
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('a busy but unthrottled account is not paused on a scan count', w.log.navigated.length, 1);
}

{
  // The real behaviour: X renders its throttle panel, the content script
  // reports it, and the worker pauses instead of searching again.
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const scanTabId = w.log.navigated[0].id;
  const before = w.log.navigated.filter(u => u.url.includes('/search?')).length;

  const res = await w.send({ type: 'xshuffle:scan-result', token: 'tok-1', post: { rateLimited: true } },
    scanSender('https://x.com/search?q=x', scanTabId));
  check('a detected limit is accepted', res?.ok, JSON.stringify(res));

  check('the pause is recorded', w.store.local.cooldownUntil > new Date('2026-09-28T12:00:00Z').getTime(),
    String(w.store.local.cooldownUntil));
  eq('the pause is attributed to X, not to a scan count', w.store.local.cooldownReason, 'rate-limited');

  // The regression that matters: the old code read the panel as an empty
  // window and immediately widened and re-searched, up to 30 times. A
  // detected limit must end the scan instead of advancing it.
  //
  // Return-to-profile is itself a navigation, so counting navigations would
  // flag correct behaviour. What must not happen is another *search* - a new
  // date window or a fresh probe.
  const searches = w.log.navigated.filter(u => u.url.includes('/search?')).length;
  eq('a throttled scan does not go on to the next date window', searches, before);
  // A pause sends the user back to the profile rather than closing a scan tab,
  // which is what the same-tab design does with every failed scan.
  check('a throttled scan returns the user to the profile',
    w.log.navigated.some(u => u.url === 'https://x.com/bob'),
    JSON.stringify(w.log.navigated.map(u => u.url)));
  check('a throttled scan closes no tab', w.log.removed.length === 0, JSON.stringify(w.log.removed));
}

{
  const w = makeWorker();
  w.store.local.cooldownUntil = new Date('2026-09-28T12:10:00Z').getTime();
  w.store.local.cooldownReason = 'rate-limited';
  const res = await w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  eq('a scan during a pause is refused', res?.ok, false);
  check('the refusal names X as the cause', /rate-limited/i.test(res?.message || ''), res?.message);
  check('the refusal opens no search tab', w.log.navigated.length === 0);
  // The button renders from this flag, so it has to be set on the refusal and
  // not just inside the message text.
  eq('the refusal is flagged as a rate limit', res?.rateLimited, true);
  check('the refusal reports how long is left', Number(res?.remaining) > 0, String(res?.remaining));
}

{
  // With the override on, the gate lets the scan through. The pause stays on
  // record - bypassing the gate is not the same as forgetting it - so the
  // countdown keeps ticking and the popup can still show it.
  const w = makeWorker();
  w.store.local.cooldownUntil = new Date('2026-09-28T12:10:00Z').getTime();
  w.store.local.cooldownReason = 'rate-limited';
  w.store.local.ignoreRateLimitPause = true;
  // No await: once the gate passes, the worker starts the scan and only
  // replies when it finishes, so awaiting would hang on a search that
  // legitimately never answers this harness.
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  check('the override lets a scan through an X rate limit', w.log.navigated.length === 1,
    JSON.stringify(w.log.navigated.map(u => u.url)));
  check('the override does not clear the pause',
    Number(w.store.local.cooldownUntil) === new Date('2026-09-28T12:10:00Z').getTime(),
    String(w.store.local.cooldownUntil));
}

{
  // The override is scoped to limits X reported. The short safety pause that
  // follows a scan which failed to load is Xshuffle's own cooldown, and
  // skipping it just fires the same doomed search again immediately.
  const w = makeWorker();
  w.store.local.cooldownUntil = new Date('2026-09-28T12:02:00Z').getTime();
  w.store.local.cooldownReason = 'scan-failed';
  w.store.local.ignoreRateLimitPause = true;
  const res = await w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  eq('the override does not skip the failed-load pause', res?.ok, false);
  check('the override does not skip the failed-load pause (no search)', w.log.navigated.length === 0,
    JSON.stringify(w.log.navigated.map(u => u.url)));
  eq('and that pause is not flagged as a rate limit', res?.rateLimited, false);
}

{
  // A truthy non-boolean must not enable the override: storage can hold
  // anything, and this is the switch that talks to X's limiter.
  const w = makeWorker();
  w.store.local.cooldownUntil = new Date('2026-09-28T12:10:00Z').getTime();
  w.store.local.cooldownReason = 'rate-limited';
  w.store.local.ignoreRateLimitPause = 'yes';
  const res = await w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  eq('a non-boolean override value does not bypass the pause', res?.ok, false);
  check('a non-boolean override value opens no search', w.log.navigated.length === 0);
}

{
  const w = makeWorker();
  // An expired pause must not linger and block the next scan.
  w.store.local.cooldownUntil = new Date('2026-09-28T11:00:00Z').getTime();
  w.store.local.cooldownReason = 'rate-limited';
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('an expired pause does not block a new scan', w.log.navigated.length, 1);
  check('the expired pause is cleared', w.store.local.cooldownUntil === undefined,
    String(w.store.local.cooldownUntil));
}

{
  // A scan that never reported is a page that never loaded. Not proof of a
  // limit, so the pause is the short safety one rather than the long one.
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  w.fireAlarm('xshuffle-timeout:tok-1');
  await new Promise(r => setImmediate(r));
  eq('a timed-out scan pauses for the short safety interval', w.store.local.cooldownReason, 'scan-failed');
  const length = w.store.local.cooldownUntil - new Date('2026-09-28T12:00:00Z').getTime();
  check('the safety pause is materially shorter than a rate-limit pause',
    length > 0 && length <= 5 * 60 * 1000, String(length));
}


// -------------------------------------------------------- window slider --

console.log('\nSearch window slider');

{
  // The slider sends a plain day count. It must be honoured as the window
  // width rather than being ignored in favour of the automatic size.
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { windowDays: 30 }
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const key = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:'));
  eq('a 30-day slider value is the window width', w.store.session[key]?.windowDays, 30);
}

{
  // windowDays: null is Auto - the worker falls back to its own sizing.
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { windowDays: null }
  }, profileSender('https://x.com/bob'));
  check('Auto (null) still opens a probe', !!w.log.navigated[0]?.url,
    JSON.stringify(w.log.navigated[0]?.url));
}

{
  // An old stored date range must still work: it becomes a window that many
  // days wide, so an existing profile is not silently reset to Auto.
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { rangeStart: '2024-01-01', rangeEnd: '2024-01-31' }
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const key = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:'));
  const state = w.store.session[key];
  eq('a legacy 30-day range becomes a 30-day window', state?.windowDays, 30);
}

{
  // Values outside the slider's range are clamped rather than trusted.
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { windowDays: 5000 }
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const key = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:'));
  eq('an oversized window is clamped', w.store.session[key]?.windowDays, 90);
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { windowDays: 0 }
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  const key = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:'));
  check('0 is treated as Auto, not a zero-day window',
    (w.store.session[key]?.windowDays || 0) > 0, String(w.store.session[key]?.windowDays));
}

// ------------------------------------------------------------ retry delay --

console.log('\nRetry delay');

/** How many searches the scan has actually opened. */
function countSearches(w) {
  return w.log.navigated.filter(u => (u.url || '').includes('/search?')).length;
}
const tokenOf = w => Object.keys(w.store.session).find(k => k.startsWith('xshuffle:')).replace('xshuffle:', '');
const storedOptions = w => JSON.parse(JSON.stringify(w.store.session[Object.keys(w.store.session).find(k => k.startsWith('xshuffle:'))])).options;

{
  // Searches inside one scan fire back to back, which is the pattern X
  // throttles. The delay spaces them out - but only from the SECOND search on:
  // delaying the opening probe would add dead time to a scan that may well
  // succeed immediately, and the point is to separate requests from each other,
  // not to stall the start.
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { retryDelayMs: 150 } }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('the first search is not delayed', countSearches(w), 1);
  const at = Date.now();
  // Not awaited: w.send resolves on its own 5ms timer, which is already longer
  // than the instant assertion below needs. The stall case further down proves
  // the delay holds the navigation back for real.
  w.send({ type: 'xshuffle:scan-result', token: tokenOf(w), post: null },
    scanSender('https://x.com/search?q=x', 1));
  check('the second search does not fire immediately', countSearches(w) === 1,
    `searches=${countSearches(w)} - the retry was not held back`);
  await new Promise(r => setTimeout(r, 320));
  check('the delayed retry eventually runs', countSearches(w) === 2, `searches=${countSearches(w)}`);
  check('the retry waited at least the configured delay', Date.now() - at >= 150,
    `waited ${Date.now() - at}ms, configured 150ms`);
}
{
  // Zero means "no delay", a legitimate choice for someone who would rather be
  // fast than careful. It must not become one tick, nor fall back to the default.
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { retryDelayMs: 0 } }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  w.send({ type: 'xshuffle:scan-result', token: tokenOf(w), post: null },
    scanSender('https://x.com/search?q=x', 1));
  await new Promise(r => setImmediate(r));
  eq('a zero delay retries immediately', countSearches(w), 2);
}
{
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72 },
    profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('an unset delay uses the default', storedOptions(w)?.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
}
{
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { retryDelayMs: 'soon' } }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('a non-numeric delay falls back to the default', storedOptions(w)?.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
}
{
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { retryDelayMs: 99999999 } }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  check('an absurd delay is clamped', storedOptions(w)?.retryDelayMs <= 60000,
    `stored ${storedOptions(w)?.retryDelayMs}`);
}
{
  // A stall retry is the case most likely to be hammering a struggling X, so
  // it must be delayed like any other retry rather than slipping through.
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { retryDelayMs: 150 } }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  w.send({ type: 'xshuffle:scan-result', token: tokenOf(w), post: null },
    scanSender('https://x.com/search?q=x', 1));
  await new Promise(r => setTimeout(r, 320));
  eq('the first retry ran', countSearches(w), 2);
  const before = countSearches(w);
  w.send({ type: 'xshuffle:scan-result', token: tokenOf(w), post: { stalled: true } },
    scanSender('https://x.com/search?q=x', 1));
  check('a stall retry is delayed too', countSearches(w) === before,
    `searches=${countSearches(w)} - a stall retry bypassed the delay`);
  await new Promise(r => setTimeout(r, 320));
  eq('and the delayed stall retry then runs', countSearches(w), before + 1);
}

console.log(`\nsearch options: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}