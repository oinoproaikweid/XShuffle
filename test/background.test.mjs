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
  const store = { session: {} };
  const log = { created: [], updated: [], removed: [], messages: [], alarms: [], cleared: [] };
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
    },
    alarms: {
      create: (name, info) => log.alarms.push({ name, when: info.when }),
      clear: name => { log.cleared.push(name); return true; },
      onAlarm: { addListener: fn => alarmListeners.push(fn) },
    },
    tabs: {
      create: ({ url, active }, cb) => { const id = nextTabId++; log.created.push({ url, active, id }); cb && cb({ id, url }); },
      update: (id, { url }, cb) => { log.updated.push({ id, url }); cb && cb({ id, url }); },
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
const scanTabIdOf = w => w.log.created[0]?.id;

// ---------------------------------------------------------------- URL building

console.log('\n\x1b[1mURL construction\x1b[0m');
{
  const w = makeWorker();
  const r = await w.send(
    { type: 'xshuffle:discover', username: 'alice', joinDate: '2023-01-15', requestId: 7 },
    profileSender('https://x.com/alice', 1)
  );
  const url = w.log.created[0]?.url || '';
  check('opens a scan tab', !!url);
  check('scan tab is inactive', w.log.created[0]?.active === false);
  check('uses x.com/search', url.startsWith('https://x.com/search?'));
  check('has from: filter', decodeURIComponent(url).includes('from:alice'));
  check('has since: bound', decodeURIComponent(url).includes('since:'));
  check('has until: bound', decodeURIComponent(url).includes('until:'));
  check('carries xs_join', url.includes('xs_join=2023-01-15'));
  check('carries xs_scan token', url.includes('xs_scan='));
  check('discover responds after async', r === undefined || r === null);
}

// ---------------------------------------------------------- window selection

console.log('\n\x1b[1mWindow selection (7-day, non-overlapping, older-weighted)\x1b[0m');
{
  // Joined 2023-01-01, today 2026-09-28 => many windows available.
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1 }, profileSender('https://x.com/bob', 1));
  const url = decodeURIComponent(w.log.created[0].url);
  const m = windowOf(url);
  check('window has since/until', !!m);
  if (m) {
    const s = new Date(m[1] + 'T00:00:00Z'), e = new Date(m[2] + 'T00:00:00Z');
    const days = Math.round((e - s) / 86400000);
    check('window is <= 7 days wide', days <= 7, `got ${days}`);
    check('window starts on/after join date', s >= new Date('2023-01-01T00:00:00Z'));
    check('window ends in the future-ward direction', e > s);
  }
}
{
  // Older bias: sample many windows, oldest should appear more often than newest.
  const w = makeWorker();
  const picks = [];
  for (let i = 0; i < 300; i++) {
    const ww = makeWorker();
    await ww.send({ type: 'xshuffle:discover', username: 'c', joinDate: '2020-01-01', requestId: 1 }, profileSender('https://x.com/c', 1));
    const u = decodeURIComponent(ww.log.created[0].url);
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
  const seen = new Set([windowOf(w.log.created[0].url)[0]]);
  const scanId = scanTabIdOf(w);
  for (let i = 0; i < 5; i++) {
    w.tabUrls[scanId] = 'https://x.com/search?q=from:dave';
    await w.send({ type: 'xshuffle:scan-result', token: tok, post: null }, scanSender('https://x.com/search?q=from:dave', scanId));
    const g = windowOf(w.log.updated[w.log.updated.length - 1]?.url || '');
    if (g) seen.add(g[0]);
  }
  const total = w.log.created.length + w.log.updated.length;
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
  const issued = w.log.created.length + w.log.updated.length;
  check('stops at 30 windows', issued <= 30, `issued=${issued}`);
  check('reports failure to the page', w.log.messages.some(m => m.msg.type === 'xshuffle:complete' && m.msg.response?.ok === false));
  check('closes the scan tab', w.log.removed.length > 0);
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
  const rejected = (r?.ok === false) || w.log.created.length === 0;
  check(`rejects ${label}`, rejected, `response=${JSON.stringify(r)}`);
}
{
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'a', joinDate: '2023-01-01', requestId: 1 }, { tab: { id: 1, url: 'https://evil.example/alice' } });
  check('rejects non-x.com sender', w.log.created.length === 0);
}

// -------------------------------------------------------- post validation

console.log('\n\x1b[1mScan result validation\x1b[0m');
async function startScan(username = 'frank', joinDate = '2023-01-01') {
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username, joinDate, requestId: 1 }, profileSender(`https://x.com/${username}`, 1));
  const tok = Object.keys(w.store.session)[0].replace('xshuffle:', '');
  const scanId = scanTabIdOf(w);
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
  check('daily search is exactly 1 day', !!dest && (() => {
    const g = windowOf(dest);
    if (!g) return false;
    return (new Date(g[2] + 'T00:00:00Z') - new Date(g[1] + 'T00:00:00Z')) === 86400000;
  })());
  check('closes the scan tab on success', w.log.removed.includes(scanId));
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
  // out-of-window post: inside join..today but outside the active window
  const { w, tok, scanId } = await startScan('grace', '2020-01-01');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const far = new Date(new Date(cur.end + 'T00:00:00Z').getTime() + 8 * 86400000).toISOString().slice(0, 10);
  const r = await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '42', day: far } }, scanSender('https://x.com/search?q=x', scanId));
  check('rejects post outside the active window', r?.ok === false, `day=${far} window=${cur.start}..${cur.end}`);
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
  check('does not navigate the tab', w.log.updated.length === 0, `updated=${w.log.updated.length}`);
}
{
  const { w, tok, scanId } = await startScan('ivan');
  const cur = JSON.parse(JSON.stringify(Object.values(w.store.session)[0])).currentWindow;
  const day = new Date(new Date(cur.start + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
  w.tabUrls[1] = 'https://x.com/search?q=from%3Aivan';   // still the same account, on search
  await w.send({ type: 'xshuffle:scan-result', token: tok, post: { id: '9', day } }, scanSender('https://x.com/search?q=x', scanId));
  check('still allows the result on the same account search page', w.log.updated.length > 0);
}

// ------------------------------------------------------------------- timeouts

console.log('\n\x1b[1mTimeout\x1b[0m');
{
  const w = makeWorker();
  await w.send({ type: 'xshuffle:discover', username: 'judy', joinDate: '2023-01-01', requestId: 1 }, profileSender('https://x.com/judy', 1));
  check('arms a 90s alarm', w.log.alarms.some(a => a.name.startsWith('xshuffle-timeout:')));
  const name = w.log.alarms[0].name;
  w.fireAlarm(name);
  await new Promise(r => setTimeout(r, 5));
  const completion = w.log.messages.filter(m => m.msg.type === 'xshuffle:complete').pop();
  check('timeout reports failure', completion?.msg.response?.ok === false);
  check('timeout closes the scan tab', w.log.removed.length > 0);
  check('timeout clears the alarm', w.log.cleared.includes(name));
}

// ------------------------------------------------------------------ summary

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
