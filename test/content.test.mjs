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

/** Build a search results page. `posts` = [{user,id,iso}] */
function searchPage(posts, { noResults = false, inner = '' } = {}) {
  const cards = posts.map(p => `
    <article data-testid="tweet">
      <a href="/${p.user}/status/${p.id}"><time datetime="${p.iso}">${p.iso.slice(0, 10)}</time></a>
    </article>`).join('');
  const body = noResults ? '<div>No results for "from:frank"</div>' : cards;
  return `<!doctype html><html><body>
    <div data-testid="primaryColumn">${body}${inner}</div>
  </body></html>`;
}

/**
 * Run content.js inside jsdom. Returns the messages the script sent back to
 * the background worker. Deferred work (queueMicrotask / setTimeout) is
 * flushed before returning, so callers get a settled view.
 */
async function run(html, url) {
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
  dom.window.chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => { sent.push(msg); cb && cb({ ok: true }); },
    },
    storage: {
      local: { get: (d, cb) => cb({ showShuffleUI: true }), set() {} },
      onChanged: { addListener() {} },
    },
  };
  dom.window.eval(SRC);
  // Let the script's microtask (scheduleRefresh) and the discovery scan run.
  await new Promise(r => setTimeout(r, 20));
  lastDom = dom;
  currentMessages = sent;
  return { dom, sent };
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

// ------------------------------------------------------------------ summary

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
