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
  const log = { created: [], updated: [], removed: [], messages: [], alarms: [], cleared: [] };
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
        remove: k => { delete store.local[k]; }
      }
    },
    alarms: {
      create: (name, info) => log.alarms.push({ name, when: info.when }),
      clear: name => { log.cleared.push(name); return true; },
      onAlarm: { addListener: fn => alarmListeners.push(fn) }
    },
    tabs: {
      create: ({ url, active }, cb) => { const id = nextTabId++; log.created.push({ url, active, id }); cb && cb({ id, url }); },
      update: (id, { url }, cb) => { log.updated.push({ id, url }); cb && cb({ id, url }); },
      remove: (id, cb) => { log.removed.push(id); cb && cb(); },
      get: (id, cb) => cb({ id, url: store.session.__tabUrl || 'https://x.com/bob' }),
      sendMessage: (id, msg, cb) => { log.messages.push({ id, msg }); cb && cb(); }
    }
  };
  const sandbox = vm.createContext({ chrome, crypto: { randomUUID: () => 'tok-1' }, console, Date: FakeDate, URLSearchParams, URL, Math });
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
  check('excludeReplies adds filter:replies', /filter:replies/.test(queryOf(w.log.created[0]?.url)),
    queryOf(w.log.created[0]?.url));
  check('excludeReplies alone adds no media filter', !/filter:media/.test(queryOf(w.log.created[0]?.url)));
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { mediaOnly: true }
  }, profileSender('https://x.com/bob'));
  check('mediaOnly adds filter:media', /filter:media/.test(queryOf(w.log.created[0]?.url)));
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { excludeReplies: true, mediaOnly: true }
  }, profileSender('https://x.com/bob'));
  const q = queryOf(w.log.created[0]?.url);
  check('both filters combine', /filter:replies/.test(q) && /filter:media/.test(q), q);
  check('filters sit after the date bounds', q.indexOf('until:') < q.indexOf('filter:'), q);
}

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { excludeReplies: 'yes-please' }
  }, profileSender('https://x.com/bob'));
  check('non-boolean filter values are ignored',
    !/filter:replies/.test(queryOf(w.log.created[0]?.url)));
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
  const q = queryOf(w.log.created[0]?.url);
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
    !/since:2024-03-01/.test(queryOf(w.log.created[0]?.url)),
    queryOf(w.log.created[0]?.url));
}

{
  const w = makeWorker();
  const res = await w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1,
    postCount: 72, options: { rangeStart: '2024-03-31', rangeEnd: '2024-03-01' }
  }, profileSender('https://x.com/bob'));
  eq('an inverted range is refused', res?.ok, false);
  check('an inverted range opens no search tab', w.log.created.length === 0);
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
  const probeUrl = w.log.created[0]?.url;
  const scanId = w.log.created[0].id;
  // Empty probe -> the worker opens a windowed search in the same tab.
  await w.send({ type: 'xshuffle:scan-result', token: 'tok-1', post: null }, scanSender(probeUrl, scanId));
  await new Promise(r => setImmediate(r));
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

console.log('\nRate-limit cooldown');

{
  const w = makeWorker();
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('an allowed scan opens exactly one search tab', w.log.created.length, 1);
  check('scan start is recorded',
    Array.isArray(w.store.local.recentScans) && w.store.local.recentScans.length === 1,
    JSON.stringify(w.store.local.recentScans));
}

{
  const w = makeWorker();
  // Pretend the user already burned the whole allowance in this window.
  // Timestamps must come from the harness's own frozen clock, not Date.now():
  // the worker sees FakeDate, so real-clock values land in the future and are
  // discarded as stale, which would silently disable the gate under test.
  const frozenNow = new Date('2026-09-28T12:00:00Z').getTime();
  w.store.local.recentScans = Array.from({ length: 12 }, (_, i) => frozenNow - i * 1000);
  const res = await w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  eq('scan is refused once the allowance is spent', res?.ok, false);
  check('refusal explains the pause', /rate-limit|pauses/i.test(res?.message || ''), res?.message);
  check('refusal opens no search tab', w.log.created.length === 0);
  check('refusal does not consume more of the allowance',
    w.store.local.recentScans.length === 12, String(w.store.local.recentScans.length));
}

{
  const w = makeWorker();
  // Scans older than the cooldown window must not count against the user.
  const frozenNow = new Date('2026-09-28T12:00:00Z').getTime();
  const old = frozenNow - 20 * 60 * 1000;
  w.store.local.recentScans = Array.from({ length: 12 }, () => old);
  w.send({
    type: 'xshuffle:discover', username: 'bob', joinDate: '2023-01-01', requestId: 1, postCount: 72
  }, profileSender('https://x.com/bob'));
  await new Promise(r => setImmediate(r));
  eq('stale scans are discarded, so the scan is allowed', w.log.created.length, 1);
  eq('only the new scan remains', w.store.local.recentScans.length, 1);
}

console.log(`\nsearch options: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}