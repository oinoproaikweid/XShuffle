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
  const log = { created: [], updated: [], removed: [], messages: [] };
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
        log.created.push({ url, active, id }); cb && cb({ id, url });
      },
      update: (id, { url }, cb) => { tabUrls[id] = url; log.updated.push({ id, url }); cb && cb({ id, url }); },
      remove: (id, cb) => { log.removed.push(id); cb && cb(); },
      get: (id, cb) => cb({ id, url: tabUrls[id] }),
      sendMessage: (id, msg, cb) => { log.messages.push({ id, msg }); cb && cb(); }
    }
  };
  const sandbox = vm.createContext({ chrome, crypto: { randomUUID: () => 'tok-1' }, console, Date: FakeDate, URLSearchParams, URL, Math });
  vm.runInContext(SRC, sandbox);
  return {
    log, store, tabUrls,
    send: (msg, sender) => new Promise(res => messageListener(msg, sender, res)),
    setTabUrl: (id, url) => { tabUrls[id] = url; }
  };
}

const tick = () => new Promise(r => setImmediate(r));
const profileSender = (url, id = 1) => ({ tab: { id, url } });
const scanSender = (url, id = 500) => ({ url, tab: { id, url } });
const queryOf = url => new URL(url).searchParams.get('q');

async function startProbe(options = {}, joinDate = '2023-01-01') {
  const w = makeWorker();
  w.send({ type: 'xshuffle:discover', username: 'liljayxxo', joinDate, requestId: 1, postCount: 72, options },
    profileSender('https://x.com/liljayxxo'));
  await tick();
  const tok = Object.keys(w.store.session).find(k => k.startsWith('xshuffle:')).replace('xshuffle:', '');
  const probeUrl = w.log.created[0].url;
  return { w, tok, probeUrl, scanId: w.log.created[0].id };
}

// The four posts a real whole-history search returned for this account.
const REAL_POSTS = [
  { id: '111', day: '2023-02-20' },
  { id: '222', day: '2024-02-29' },
  { id: '333', day: '2024-02-29' },
  { id: '444', day: '2025-04-23' }
];

console.log('\nProbe search URL');

{
  const { probeUrl } = await startProbe();
  check('probe carries the xs_probe flag', /xs_probe=1/.test(probeUrl));
  // URLSearchParams encodes spaces in q= as '+', not %20.
  const q = new URL(probeUrl).searchParams.get('q');
  check('probe spans join date to tomorrow', /since:2023-01-01/.test(q) && /until:2026-09-29/.test(q), q);
  check('probe is a single search over the whole history', /from:liljayxxo since:2023-01-01/.test(q), q);
}

{
  const { probeUrl } = await startProbe({ excludeReplies: true, mediaOnly: true });
  const q = queryOf(probeUrl);
  check('probe carries the reply filter', /filter:replies/.test(q), q);
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
  const { w, tok, probeUrl, scanId } = await startProbe();
  w.setTabUrl(1, 'https://x.com/liljayxxo');
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: REAL_POSTS } },
    scanSender(probeUrl, scanId));
  eq('a probe with posts succeeds immediately', r?.ok, true);
  const dest = w.log.updated.filter(u => u.id === 1).map(u => u.url);
  eq('the user tab is navigated once', dest.length, 1);
  const q = dest.length ? new URL(dest[0]).searchParams.get('q') : '';
  check('it navigates to a day that really has a post',
    REAL_POSTS.some(p => `since:${p.day}` === /since:\S+/.exec(q)?.[0]), q);
  check('the chosen day comes from the probe, not a guess',
    ['2023-02-20', '2024-02-29', '2025-04-23'].some(d => q.includes(`since:${d}`)), q);
  check('the scan tab is closed', w.log.removed.includes(scanId));
}

{
  // The whole point: a rare poster with years between posts still succeeds.
  const { w, tok, probeUrl, scanId } = await startProbe();
  w.setTabUrl(1, 'https://x.com/liljayxxo');
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: REAL_POSTS } },
    scanSender(probeUrl, scanId));
  check('a 4-post account spanning 2 years succeeds where 7-day windows failed',
    r?.ok === true, JSON.stringify(r));
}

console.log('\nProbe result validation');

{
  const { w, tok, probeUrl, scanId } = await startProbe();
  w.setTabUrl(1, 'https://x.com/liljayxxo');
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: [
      { id: 'not-numeric', day: '2024-01-01' },
      { id: '555', day: 'not-a-date' },
      { id: '666', day: '2019-01-01' },          // before join
      { id: '777', day: '2027-01-01' },          // future
      { id: '888', day: '2024-05-05' }           // the only valid one
    ] } },
    scanSender(probeUrl, scanId));
  eq('a probe with one valid post still succeeds', r?.ok, true);
  const dest = w.log.updated.filter(u => u.id === 1).map(u => new URL(u.url).searchParams.get('q'));
  check('invalid probe entries are discarded', dest.length === 1 && /since:2024-05-05/.test(dest[0]),
    JSON.stringify(dest));
}

{
  const { w, tok, probeUrl, scanId } = await startProbe();
  w.setTabUrl(1, 'https://x.com/liljayxxo');
  const r = await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: [] } },
    scanSender(probeUrl, scanId));
  eq('an empty probe array does not succeed', r?.ok, false);
  const completion = w.log.messages.filter(m => m.msg.type === 'xshuffle:complete').pop();
  check('an empty probe reports a clear message',
    /no searchable posts/i.test(completion?.msg.response?.message || ''),
    JSON.stringify(completion?.msg.response));
  check('an empty probe does not navigate the user tab', !w.log.updated.some(u => u.id === 1));
}

{
  // A manual range must also bound which probe results are acceptable.
  const { w, tok, probeUrl, scanId } = await startProbe({ rangeStart: '2025-01-01', rangeEnd: '2025-12-31' });
  w.setTabUrl(1, 'https://x.com/liljayxxo');
  await w.send(
    { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: REAL_POSTS } },
    scanSender(probeUrl, scanId));
  const dest = w.log.updated.filter(u => u.id === 1).map(u => new URL(u.url).searchParams.get('q'));
  check('posts outside the manual range are discarded',
    dest.every(q => /since:2025-04-23/.test(q)), JSON.stringify(dest));
}

console.log('\nProbe distribution');

{
  // Older posts should be favoured, matching the windowed scan's bias.
  const counts = {};
  for (let i = 0; i < 300; i++) {
    const { w, tok, probeUrl, scanId } = await startProbe();
    w.setTabUrl(1, 'https://x.com/liljayxxo');
    await w.send(
      { type: 'xshuffle:scan-result', token: tok, post: { id: null, day: null, probe: REAL_POSTS } },
      scanSender(probeUrl, scanId));
    const dest = w.log.updated.filter(u => u.id === 1);
    if (dest.length) {
      const q = new URL(dest[0].url).searchParams.get('q');
      const day = (/since:(\S+)/.exec(q) || [])[1];
      if (day) counts[day] = (counts[day] || 0) + 1;
    }
  }
  const oldest = counts['2023-02-20'] || 0;
  const newest = counts['2025-04-23'] || 0;
  check('the oldest post is drawn more often than the newest',
    oldest > newest, `oldest=${oldest} newest=${newest}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  check('every draw lands on a real post day', total === 300, `${total}/300`);
}

console.log(`\nprobe search: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
