/**
 * Headless DOM tests for the Xshuffle content script.
 *
 * Loads the real content.js in jsdom against fixture markup that mimics X's
 * profile header and search result cards, and drives the join-date parser and
 * the discovery scanner.
 *
 * Run: node test/content.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'content.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); }
}

/** Build a profile page with the given header innerText. */
function profilePage(headerText, { href = '/frank' } = {}) {
  return `<!doctype html><html><body>
    <div data-testid="primaryColumn">
      <div data-testid="UserProfileHeader_Items"><span>${headerText}</span></div>
      <a href="${href}/about">About</a>
    </div>
  </body></html>`;
}

/**
 * Build a search results page. `posts` = [{user,id,iso}]
 *
 * `toolbar` adds the search form and its adjacent button that X renders on a
 * real /search page. The Shuffle button on a search page is injected next to
 * that button, and the slot is found by comparing bounding boxes - so the
 * mock has to give those elements real geometry, which jsdom reports as all
 * zeroes. Without that, getSearchToolbarSlot() correctly finds no slot and the
 * button is (rightly) not injected.
 */
function searchPage(posts, { noResults = false, inner = '', toolbar = false } = {}) {
  const cards = posts.map(p => `
    <article data-testid="tweet">
      <a href="/${p.user}/status/${p.id}"><time datetime="${p.iso}">${p.iso.slice(0, 10)}</time></a>
    </article>`).join('');
  const body = noResults ? '<div>No results for "from:frank"</div>' : cards;
  const chrome = toolbar ? `
    <div data-testid="xshuffle-fixture-toolbar">
      <form role="search"><input name="q" /></form>
      <button type="button">Search</button>
    </div>` : '';
  return `<!doctype html><html><body>
    <div data-testid="primaryColumn">${chrome}${body}${inner}</div>
  </body></html>`;
}

/**
 * Give the toolbar elements a geometry jsdom can report, so
 * getSearchToolbarSlot() can locate the button to sit beside. jsdom has no
 * layout engine, so getBoundingClientRect() is stubbed per element: the form
 * occupies the left half and the button the right, on the same line.
 */
function withToolbarGeometry(dom) {
  const rect = (left, right) => ({
    left, right, top: 0, bottom: 40, width: right - left, height: 40,
    x: left, y: 0, toJSON() { return this; }
  });
  const form = dom.window.document.querySelector('[role="search"]');
  const button = dom.window.document.querySelector('[data-testid="xshuffle-fixture-toolbar"] button');
  if (form) form.getBoundingClientRect = () => rect(0, 200);
  if (button) button.getBoundingClientRect = () => rect(210, 280);
  return dom;
}

/**
 * Run content.js inside jsdom. Returns the messages the script sent back to
 * the background worker. Deferred work (queueMicrotask / setTimeout) is
 * flushed before returning, so callers get a settled view.
 *
 * `seedStorage` pre-populates chrome.storage.local, which is how a test sets
 * up a warm profile cache. The mock honours the defaults object the way the
 * real storage API does - returning the default for any key not yet written -
 * because the profile cache relies on that to tell "no entry" from "absent
 * key", and a mock that returned {} regardless would hide the difference.
 */
async function run(html, url, { seedStorage = {} } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  // jsdom does not implement innerText; approximate it with textContent,
  // which is what the real code falls back to anyway.
  dom.window.Element.prototype.innerText = null;
  Object.defineProperty(dom.window.Element.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true,
  });
  const sent = [];
  // A real store, not a stub: the profile cache writes and reads through this,
  // so a mock that discarded writes could not tell a cache that populated
  // from one that silently did nothing.
  const localStore = { showShuffleUI: true, ...seedStorage };
  dom.window.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => { sent.push(msg); cb && cb({ ok: true }); },
    },
    storage: {
      local: {
        get: (defaults, cb) => {
          const result = {};
          if (typeof defaults === 'string') {
            result[defaults] = localStore[defaults];
          } else {
            for (const key of Object.keys(defaults)) {
              result[key] = key in localStore ? localStore[key] : defaults[key];
            }
          }
          cb(result);
        },
        set: values => { Object.assign(localStore, values); },
        remove: key => {
          for (const k of (Array.isArray(key) ? key : [key])) delete localStore[k];
        }
      },
      onChanged: { addListener() {} },
    },
  };
  dom.window.eval(SRC);
  // jsdom has no layout engine, so the toolbar stub geometry has to be in place
  // before content.js runs - refresh() reads it on its very first pass.
  withToolbarGeometry(dom);
  // Let the script's microtask (scheduleRefresh) and the discovery scan run.
  await new Promise(r => setTimeout(r, 20));
  lastDom = dom;
  currentMessages = sent;
  return { dom, sent, store: localStore };
}
/** Most recent page + its outbound messages, used by clickShuffle below. */
let lastDom = null;
let currentMessages = [];

/** Click the injected Shuffle button, which triggers xshuffle:discover. */
async function clickShuffle() {
  const dom = lastDom;
  const btn = dom.window.document.querySelector('.xshuffle-controls .xshuffle-button');
  if (!btn) return false;
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  return true;
}

// ------------------------------------------------------------- join date

console.log('\n\x1b[1mJoin date parsing\x1b[0m');
{
  await run(profilePage('Joined January 2023'), 'https://x.com/frank');
  const clicked = await clickShuffle();
  check('injects a Shuffle button', clicked);
  check('sends a discover request on click', currentMessages.some(m => m.type === 'xshuffle:discover'));
  const d = currentMessages.find(m => m.type === 'xshuffle:discover');
  check('parses "Joined January 2023"', d?.joinDate === '2023-01-01', `got ${d?.joinDate}`);
  check('sends the username', d?.username === 'frank', `got ${d?.username}`);
}
{
  await run(profilePage('Joined December 2009'), 'https://x.com/someuser');
  await clickShuffle();
  const d = currentMessages.find(m => m.type === 'xshuffle:discover');
  check('parses month correctly (December)', d?.joinDate === '2009-12-01', `got ${d?.joinDate}`);
}
{
  // X sometimes only renders the join date on the /about view
  const html = `<!doctype html><html><body>
    <div data-testid="primaryColumn">
      <div data-testid="UserProfileHeader_Items"><span>Joined March 2015</span></div>
    </div></body></html>`;
  await run(html, 'https://x.com/x');
  await clickShuffle();
  const d = currentMessages.find(m => m.type === 'xshuffle:discover');
  check('parses join date', d?.joinDate === '2015-03-01', `got ${d?.joinDate}`);
}
{
  // Case-insensitivity
  await run(profilePage('joined july 2021'), 'https://x.com/u');
  await clickShuffle();
  const d = currentMessages.find(m => m.type === 'xshuffle:discover');
  check('case-insensitive month match', d?.joinDate === '2021-07-01', `got ${d?.joinDate}`);
}
{
  await run(profilePage('Followers 1,234'), 'https://x.com/nodate');
  await clickShuffle();
  check('sends nothing when no join date is present', !currentMessages.some(m => m.type === 'xshuffle:discover'));
}
{
  // Reserved route should not be treated as a profile
  const { sent } = await run(profilePage('Joined January 2020'), 'https://x.com/home');
  check('ignores reserved routes like /home', !sent.some(m => m.type === 'xshuffle:discover'));
}
{
  const { sent } = await run(profilePage('Joined January 2020'), 'https://x.com/settings');
  check('ignores /settings', !sent.some(m => m.type === 'xshuffle:discover'));
}

// ------------------------------------------------------ discovery scanning

console.log('\n\x1b[1mDiscovery scanning\x1b[0m');
const scanUrl = (extra = '') =>
  `https://x.com/search?q=from%3Afrank+since%3A2023-01-01+until%3A2023-01-08&xs_join=2023-01-01&xs_scan=tok1${extra}`;

{
  const { sent } = await run(searchPage([{ user: 'frank', id: '111', iso: '2023-03-05T10:00:00.000Z' }]), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('reports a found post', !!r && !!r.post, JSON.stringify(r));
  check('reports the correct post id', r?.post?.id === '111', `got ${r?.post?.id}`);
  check('reports the correct day', r?.post?.day === '2023-03-05', `got ${r?.post?.day}`);
  check('echoes the scan token', r?.token === 'tok1', `got ${r?.token}`);
}
{
  const { sent } = await run(searchPage([], { noResults: true }), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('reports null on "No results"', r && r.post === null, JSON.stringify(r));
}
{
  // Empty results but no explicit empty state -> stays silent, lets the worker retry
  const { sent } = await run(searchPage([]), scanUrl());
  check('stays silent when results are merely empty', !sent.some(m => m.type === 'xshuffle:scan-result'));
}
{
  // A post from a DIFFERENT account must be ignored
  const { sent } = await run(searchPage([{ user: 'someoneelse', id: '999', iso: '2023-03-05T10:00:00.000Z' }]), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('ignores posts from another account', !r || r.post === null, JSON.stringify(r));
}
{
  // A post BEFORE the join date must be ignored
  const { sent } = await run(searchPage([{ user: 'frank', id: '222', iso: '2019-01-05T10:00:00.000Z' }]), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('ignores posts before the join date', !r || r.post === null, JSON.stringify(r));
}
{
  // A FUTURE post must be ignored
  const { sent } = await run(searchPage([{ user: 'frank', id: '333', iso: '2099-01-05T10:00:00.000Z' }]), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('ignores future-dated posts', !r || r.post === null, JSON.stringify(r));
}
{
  // No xs_scan token -> not a discovery page, must not report
  const plain = 'https://x.com/search?q=from%3Afrank';
  const { sent } = await run(searchPage([{ user: 'frank', id: '444', iso: '2023-03-05T10:00:00.000Z' }]), plain);
  check('does not report without a scan token', !sent.some(m => m.type === 'xshuffle:scan-result'));
}
{
  // Missing xs_join -> not a discovery page
  const noJoin = 'https://x.com/search?q=from%3Afrank&xs_scan=tok1';
  const { sent } = await run(searchPage([{ user: 'frank', id: '555', iso: '2023-03-05T10:00:00.000Z' }]), noJoin);
  check('does not report without xs_join', !sent.some(m => m.type === 'xshuffle:scan-result'));
}
{
  // Multiple posts: must report exactly one, and it must be from the set
  const many = [
    { user: 'frank', id: '1001', iso: '2023-03-01T10:00:00.000Z' },
    { user: 'frank', id: '1002', iso: '2023-03-02T10:00:00.000Z' },
    { user: 'frank', id: '1003', iso: '2023-03-03T10:00:00.000Z' },
  ];
  const { sent } = await run(searchPage(many), scanUrl());
  const results = sent.filter(m => m.type === 'xshuffle:scan-result' && m.post);
  check('reports exactly one post when several exist', results.length === 1, `got ${results.length}`);
  check('the chosen post is one of the visible ones', many.some(p => p.id === results[0]?.post?.id));
}
{
  // Duplicate cards for the same status must not break anything
  const dup = [
    { user: 'frank', id: '1004', iso: '2023-03-01T10:00:00.000Z' },
    { user: 'frank', id: '1004', iso: '2023-03-01T10:00:00.000Z' },
  ];
  const { sent } = await run(searchPage(dup), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('handles duplicate status cards', !!r?.post && r.post.id === '1004', JSON.stringify(r));
}
{
  // A tweet with no time element must be skipped
  const html = `<!doctype html><html><body><div data-testid="primaryColumn">
    <article data-testid="tweet"><a href="/frank/status/777">no time element</a></article>
  </div></body></html>`;
  const { sent } = await run(html, scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('skips cards with no timestamp', !r || r.post === null, JSON.stringify(r));
}
{
  // Username case must not matter
  const { sent } = await run(searchPage([{ user: 'FRANK', id: '1005', iso: '2023-03-05T10:00:00.000Z' }]), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('matches username case-insensitively', r?.post?.id === '1005', JSON.stringify(r));
}

// ------------------------------------------------------- rate-limit panel
//
// When X throttles a search it renders an error panel instead of results.
// Before this was detected the panel looked exactly like an empty date
// window, so the worker counted a miss and immediately widened and searched
// again - hammering an account that had already refused. These fixtures pin
// the panel apart from a genuine "No results" page, which is the distinction
// the whole pause depends on.

console.log('\n\x1b[1mRate-limit panel detection\x1b[0m');

/** X's throttle panel: an error heading plus its own Reload control. */
function rateLimitPage({ heading = 'Something went wrong', button = 'Reload' } = {}) {
  return `<!doctype html><html><body><div data-testid="primaryColumn">
    <div><h2>${heading}</h2><span>Try reloading the page.</span></div>
    <div role="button" tabindex="0">${button}</div>
  </div></body></html>`;
}

{
  const { sent } = await run(rateLimitPage(), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('a throttled page is reported as rate-limited, not as an empty window',
    r?.post?.rateLimited === true, JSON.stringify(r));
}

{
  // The panel must be reported before the "No results" fallback can claim
  // it, and it must not be dressed up as a post.
  const { sent } = await run(rateLimitPage({ heading: 'Rate limit exceeded' }), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('an explicit rate-limit heading is detected too', r?.post?.rateLimited === true, JSON.stringify(r));
  check('a throttled page never yields a post id', !r?.post?.id, JSON.stringify(r));
}

{
  // The real regression guard. A genuine empty window carries no error panel,
  // so it must still be reported as an ordinary miss - otherwise the fix
  // would pause the user every time a quiet account has a sparse week.
  const { sent } = await run(searchPage([], { noResults: true }), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('a genuinely empty window is still an ordinary miss',
    r?.post === null, JSON.stringify(r));
}

{
  // The Reload control is what makes this a positive signal. Without it the
  // page could be anything, so a bare error string must not trip a pause.
  const html = `<!doctype html><html><body><div data-testid="primaryColumn">
    <div>Something went wrong</div>
  </div></body></html>`;
  const { sent } = await run(html, scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('an error string with no Reload control does not count as throttling',
    !r?.post?.rateLimited, JSON.stringify(r));
}

{
  // Real results must never be mistaken for throttling, even if a post body
  // happens to contain the words.
  const posts = [{ user: 'frank', id: '2001', iso: '2023-04-01T10:00:00.000Z' }];
  const { sent } = await run(searchPage(posts, { inner: '<div>Something went wrong</div><div role="button">Reload</div>' }), scanUrl());
  const r = sent.find(m => m.type === 'xshuffle:scan-result');
  check('a page with real posts is not treated as throttled',
    r?.post?.id === '2001', JSON.stringify(r));
}

// ---------------------------------------------------------- profile cache
//
// A search page cannot know when an account joined or how many posts it has -
// both live on the profile. The cache is what lets a from: search the user
// typed by hand work at all, so these tests pin the two properties it has to
// have: entries are per-account, and they are dropped when a scan comes back
// empty because a stale post count is the likely cause.

console.log('\n\x1b[1mProfile cache\x1b[0m');

/** A from: search with no xs_join - i.e. one the user typed themselves. */
const typedSearchUrl = (user = 'frank') =>
  `https://x.com/search?q=from%3A${user}+since%3A2023-01-01`;

{
  // Visiting a profile records what was scraped. This is the only place the
  // numbers exist, so nothing downstream works without it.
  const { store } = await run(profilePage('Joined January 2023 · 1.2K Posts'), 'https://x.com/frank');
  const entry = store.profileCache?.frank;
  check('a profile visit records the join date', entry?.joinDate === '2023-01-01', JSON.stringify(entry));
  check('a profile visit records the post count', entry?.postCount === 1200, JSON.stringify(entry));
}

{
  // The headline behaviour: a search the user typed has no xs_join, so the
  // join date has to come from the cache or the button never appears.
  const { dom } = await run(searchPage([], { toolbar: true }), typedSearchUrl(), {
    seedStorage: { profileCache: { frank: { joinDate: '2023-01-01', postCount: 1200, seen: 1 } } }
  });
  const btn = dom.window.document.querySelector('.xshuffle-controls .xshuffle-button');
  check('a hand-typed from: search gets the Shuffle button', !!btn);
  check('the button is not disabled on a warm cache', btn && !btn.disabled);
}

{
  // Cold cache: nothing was ever scraped, so there is no join date and the
  // button must stay away rather than appear broken.
  const { dom } = await run(searchPage([], { toolbar: true }), typedSearchUrl());
  check('a hand-typed search with no cached profile gets no button',
    !dom.window.document.querySelector('.xshuffle-controls .xshuffle-button'));
}

{
  // The case that motivated per-account keys: shuffle one person, then
  // another. The page here is a search for the SECOND subject, so it must
  // read that subject's entry and never the first one's - which is exactly
  // what would happen if the cache were stored as a single "last profile"
  // value instead of per-account.
  const { dom } = await run(searchPage([], { toolbar: true }), typedSearchUrl('elon'), {
    seedStorage: {
      profileCache: {
        frank: { joinDate: '2023-01-01', postCount: 1200, seen: 2 },
        elon: { joinDate: '2006-03-01', postCount: 8000, seen: 1 }
      }
    }
  });
  const btn = dom.window.document.querySelector('.xshuffle-controls .xshuffle-button');
  check('the second subject gets a button despite the first being cached too', !!btn);
  await clickShuffle();
  const d = currentMessages.find(m => m.type === 'xshuffle:discover');
  check('a second subject uses its own join date, not the first one\'s',
    d?.joinDate === '2006-03-01', `got ${d?.joinDate}`);
  check('a second subject uses its own post count, not the first one\'s',
    d?.postCount === 8000, `got ${d?.postCount}`);
}

{
  // A scan that found nothing may have been squeezed too narrow by a stale
  // post count, so the entry is dropped and the next attempt sizes afresh.
  const { store } = await run(searchPage([], { noResults: true }), scanUrl(), {
    seedStorage: { profileCache: { frank: { joinDate: '2023-01-01', postCount: 1200, seen: 1 } } }
  });
  check('an empty scan drops the cached profile so it re-sizes next time',
    !store.profileCache?.frank, JSON.stringify(store.profileCache));
}

{
  // A scan that DID find posts proves the cached numbers were good enough, so
  // the entry must survive - otherwise every successful shuffle would throw
  // away the cache and the feature would never warm up.
  const { store } = await run(
    searchPage([{ user: 'frank', id: '1234', iso: '2023-03-05T10:00:00.000Z' }]), scanUrl(), {
      seedStorage: { profileCache: { frank: { joinDate: '2023-01-01', postCount: 1200, seen: 1 } } }
    });
  check('a successful scan keeps the cached profile',
    store.profileCache?.frank?.postCount === 1200, JSON.stringify(store.profileCache));
}

{
  // The store is bounded, so a long-lived install visiting many profiles does
  // not grow it without limit. Least-recently-seen entries go first.
  const many = {};
  for (let i = 0; i < 260; i++) {
    many[`user${i}`] = { joinDate: '2023-01-01', postCount: 10, seen: i };
  }
  const { store } = await run(profilePage('Joined January 2023'), 'https://x.com/frank', {
    seedStorage: { profileCache: many }
  });
  const size = Object.keys(store.profileCache || {}).length;
  check('the cache is capped at 200 entries', size === 200, String(size));
  check('the least recently seen entries are the ones dropped',
    !store.profileCache.user0 && !!store.profileCache.user259,
    JSON.stringify([!!store.profileCache.user0, !!store.profileCache.user259]));
}

// ------------------------------------------------- rate-limited button state

console.log('\n\x1b[1mRate-limited button state\x1b[0m');

/**
 * Click Shuffle with the worker stubbed to answer `response`, then read the
 * button back. The button is the only place a user learns a search was
 * refused because X throttled them, so its label is the feature.
 */
async function clickAndReply(response) {
  await run(profilePage('Joined January 2023'), 'https://x.com/frank');
  const dom = lastDom;
  // Re-stub sendMessage now that the page exists: the click path reads the
  // response, which run()'s stub always answers {ok:true}.
  dom.window.chrome.runtime.sendMessage = (msg, cb) => {
    currentMessages.push(msg);
    cb && cb(response);
  };
  const btn = dom.window.document.querySelector('.xshuffle-controls .xshuffle-button');
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  return btn;
}

{
  const btn = await clickAndReply({
    ok: false, rateLimited: true, remaining: 15,
    message: 'X rate-limited this account, so Xshuffle paused for 15 minutes.'
  });
  check('a refused scan labels the button Rate-Limited',
    /rate-limited/i.test(btn.textContent), `text="${btn.textContent}"`);
  check('a rate-limited button is disabled so it cannot be clicked into the limit',
    btn.disabled === true, `disabled=${btn.disabled}`);
  check('the rate-limit title names the cause and the wait',
    /rate-limited/i.test(btn.title) && /15/.test(btn.title), `title="${btn.title}"`);
}
{
  const btn = await clickAndReply({
    ok: false, message: 'X search found no visible posts for this account.'
  });
  check('an ordinary miss still offers Try again',
    /try again/i.test(btn.textContent) && btn.disabled === false,
    `text="${btn.textContent}" disabled=${btn.disabled}`);
}

// ------------------------------------------- a stall must not be the last word

console.log('\n\x1b[1mLate results after a stall\x1b[0m');

/**
 * Render results into an already-loaded page and let the observer see them.
 *
 * The fixture strings are static literals defined in this file, never user
 * input, so inserting them as markup is safe here.
 */
async function addPosts(dom, html) {
  const primary = dom.window.document.querySelector('[data-testid="primaryColumn"]');
  primary.insertAdjacentHTML('beforeend', html);
  await new Promise(r => setTimeout(r, 60));
}
const ONE_POST = '<article data-testid="tweet"><a href="/frank/status/123">' +
  '<time datetime="2024-05-02T10:00:00Z">May 2</time></a></article>';

{
  // The bug this pins: reportDiscovery() latches discoveryReported on the
  // FIRST report, so once the discovery timeout fires as a stall, results that
  // render a moment later are never read. The page visibly showed posts, the
  // worker was told "stalled", and the window was retried for no reason.
  //
  // Driven through the real timeout, shortened by patching the constant so the
  // test does not have to wait 35 seconds.
  const fast = SRC.replace(
    /const DISCOVERY_TIMEOUT_MS = \d+;/,
    'const DISCOVERY_TIMEOUT_MS = 60;');
  const dom = new JSDOM(searchPage([], { toolbar: true }), {
    url: scanUrl(), runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom.window.Element.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  const sent = [];
  const store = { showShuffleUI: true, profileCache: { frank: { joinDate: '2023-01-01', postCount: 1200, seen: 1 } } };
  dom.window.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {} },
      sendMessage: (m, cb) => { sent.push(m); cb && cb({ ok: true }); },
    },
    storage: {
      local: {
        get: (d, cb) => {
          const r = {};
          if (typeof d === 'string') r[d] = store[d];
          else for (const k of Object.keys(d)) r[k] = k in store ? store[k] : d[k];
          cb(r);
        },
        set: v => { Object.assign(store, v); }, remove() {},
      },
      onChanged: { addListener() {} },
    },
  };
  withToolbarGeometry(dom);
  dom.window.eval(fast);
  await new Promise(r => setTimeout(r, 20));
  // Let the shortened discovery timeout fire: a stall is reported.
  await new Promise(r => setTimeout(r, 150));
  const afterStall = sent.filter(m => m.type === 'xshuffle:scan-result');
  check('a stall is reported when nothing renders',
    afterStall.length === 1 && afterStall[0].post?.stalled === true,
    JSON.stringify(afterStall.map(m => m.post)));
  // Now the results render, as they would on a slow connection.
  await addPosts(dom, ONE_POST);
  await new Promise(r => setTimeout(r, 120));
  const all = sent.filter(m => m.type === 'xshuffle:scan-result');
  const real = all.filter(m => !m.post?.stalled).map(m => m.post);
  check('results arriving after a stall are still reported',
    real.length === 1, `reports=${all.length} non-stall=${real.length}: ${JSON.stringify(all.map(m => m.post))}`);
  check('and the later report carries the post that was on screen',
    real[0]?.id === '123', JSON.stringify(real[0]));
  dom.window.close();
}
{
  // The route-change reset must clear the stall flag too.
  //
  // The retry after a stall is a new URL, so scheduleRefresh resets
  // discoveryReported - but it left discoveryStalled set from the previous
  // page, so the next scan re-opened reporting on a page that had already
  // reported a real result.
  //
  // Asserted on the source because the failure needs a route change between a
  // stall and a later report, which jsdom cannot produce on demand.
  const routeReset = /discoveryQuery = location\.search;[\s\S]{0,240}?\n\s*\}/.exec(SRC);
  check('the route-change reset clears the stall flag',
    !!routeReset && /discoveryStalled = false/.test(routeReset[0]),
    routeReset ? routeReset[0].replace(/\s+/g, ' ').slice(0, 160) : 'reset block not found');
}

// --------------------------------- a landed result must end the scan for good

console.log('\n\x1b[1mSPA navigation after a result\x1b[0m');

const TWO_POSTS = '<article data-testid="tweet"><a href="/frank/status/123">' +
  '<time datetime="2024-05-02T10:00:00Z">May 2</time></a></article>' +
  '<article data-testid="tweet"><a href="/frank/status/456">' +
  '<time datetime="2024-06-02T10:00:00Z">Jun 2</time></a></article>';

// The URL the scan actually lands on once it finds a post. buildDailySearchUrl
// writes xs_join and xs_post and deliberately NOT xs_scan - the scan is over,
// so there is nothing left to report. scanUrl() hardcodes a token, so this is
// spelled out rather than derived from it.
const landingUrl = () =>
  'https://x.com/search?q=from%3Afrank+since%3A2024-05-02+until%3A2024-05-02' +
  '&src=typed_query&f=live&xs_join=2023-01-01&xs_post=555';

{
  // This is the "one skip" that survived every previous fix.
  //
  // discoveryToken is a `const` read once when content.js first runs. X is a
  // SPA, so the worker navigating the tab does NOT reload the content script -
  // the same instance lives on, still holding the token from the search page.
  // The landing page has no xs_scan, but nothing notices that: on any later
  // route change the stale token is still live, the page still has posts in it,
  // and the script reports AGAIN against a scan that already finished. The
  // worker treats it as a fresh result for a dead token and moves the tab again.
  //
  // A fresh page load is unaffected (proved separately below), which is exactly
  // why this only showed up intermittently.
  const dom = new JSDOM(searchPage([{ user: 'frank', id: '1234', iso: '2024-05-02T10:00:00.000Z' }], { toolbar: true }),
    { url: scanUrl(), runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom.window.Element.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  const sent = [];
  dom.window.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {} },
      sendMessage: (m, cb) => { sent.push(m); cb && cb({ ok: true }); },
    },
    storage: {
      local: {
        get: (d, cb) => {
          const r = {};
          if (typeof d === 'string') r[d] = undefined;
          else for (const k of Object.keys(d)) r[k] = d[k];
          cb(r);
        },
        set() {}, remove() {},
      },
      onChanged: { addListener() {} },
    },
  };
  withToolbarGeometry(dom);
  dom.window.eval(SRC);
  await new Promise(r => setTimeout(r, 40));
  const onSearch = sent.filter(m => m.type === 'xshuffle:scan-result').length;
  check('the search page reports once', onSearch === 1, `reports=${onSearch}`);

  // The scan finds a post and the tab is navigated to the landing page. X is a
  // SPA: pushState, new results rendered, no document reload.
  dom.window.history.pushState({}, '', landingUrl());
  dom.window.document.querySelector('[data-testid="primaryColumn"]')
    .insertAdjacentHTML('beforeend', TWO_POSTS);
  await new Promise(r => setTimeout(r, 150));
  const after = sent.filter(m => m.type === 'xshuffle:scan-result');
  check('the landed result page does NOT report again',
    after.length === onSearch,
    `reports=${after.length} (was ${onSearch}): ${JSON.stringify(after.map(m => m.post))}`);
  check('the landing URL carries no scan token',
    !/xs_scan=/.test(landingUrl()), landingUrl());
  dom.window.close();
}
{
  // The control: a genuine fresh load of a landing page must never report,
  // because it has no token to report with.
  const { sent } = await run(searchPage([{ user: 'frank', id: '1234', iso: '2024-05-02T10:00:00.000Z' }], { toolbar: true }),
    landingUrl());
  check('a fresh load of the landing page reports nothing',
    sent.filter(m => m.type === 'xshuffle:scan-result').length === 0,
    `reports=${sent.filter(m => m.type === 'xshuffle:scan-result').length}`);
}

// ------------------------------------------------------------------ summary

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
