(() => {
  'use strict';

  // Keep X-specific selectors together so a future markup change is easy to fix.
  const SELECTORS = {
    header: '[data-testid="UserProfileHeader_Items"]',
    primary: '[data-testid="primaryColumn"]',
    searchForm: 'form[role="search"]'
  };
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'search', 'settings',
    'compose', 'i', 'login', 'signup', 'logout', 'intent', 'share', 'hashtag',
    'tos', 'privacy', 'about', 'help', 'account', 'download', 'premium',
    'communities', 'lists', 'bookmarks', 'jobs', 'grok'
  ]);
  const MONTHS = 'january february march april may june july august september october november december'.split(' ');
  let enabled = true;
  let ignoreRateLimitPause = false;
  let overrideRevision = 0;
  let currentUrl = location.href;
  let pending = false;
  let settingsRevision = 0;
  let warnedFor = '';
  // The scan token for the URL currently on screen.
  //
  // This is read per navigation rather than captured once in a `const`, which
  // was a latent bug: X is a SPA, so navigating the tab does NOT reload the
  // content script. One instance lived on across every search page, still
  // holding the token from the first one. The landing page carries xs_join and
  // xs_post but deliberately no xs_scan - the scan is over - yet the stale
  // token was still live, so the finished scan got reported AGAIN and the
  // worker moved the tab a second time over a result the user already had.
  //
  // A fresh page load hid this, which is why it only showed up intermittently.
  function currentDiscoveryToken() {
    return new URLSearchParams(location.search).get('xs_scan');
  }
  let discoveryReported = false;
  // True only while the page's current report is a retractable stall. See
  // unstall() - this is what lets a slow page still deliver its results.
  let discoveryStalled = false;
  let discoveryQuery = location.search;
  let discoveryTimeout;
  let focusedPostId = '';

  function getCurrentProfileUsername() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts.length || RESERVED.has(parts[0].toLowerCase()) ||
        !/^[A-Za-z0-9_]{1,15}$/.test(parts[0])) return null;
    if (parts[1] && !['with_replies', 'media'].includes(parts[1])) return null;
    return parts[0];
  }

  function getJoinDate() {
    const header = document.querySelector(SELECTORS.header);
    if (!header) return null;
    const primary = document.querySelector(SELECTORS.primary);
    const aboutLinks = [...(primary || document).querySelectorAll('a[href$="/about"]')];
    const candidates = [header.innerText, header.textContent, ...header.querySelectorAll('[aria-label], [title]')]
      .map(value => typeof value === 'string' ? value :
        `${value.innerText || ''} ${value.textContent || ''} ${value.getAttribute('aria-label') || ''} ${value.getAttribute('title') || ''}`);
    for (const link of aboutLinks) candidates.push(link.innerText, link.textContent, link.getAttribute('aria-label') || '');
    if (primary) candidates.push(primary.textContent.slice(0, 3000));
    const match = candidates.join(' ').match(/\bJoined\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
    if (!match) return null;
    const year = Number(match[2]);
    const month = MONTHS.indexOf(match[1].toLowerCase());
    return new Date(Date.UTC(year, month, 1));
  }

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  /**
   * The account's lifetime post count, as X renders it on the profile.
   * Used to size the search window: a busy account can be scanned in short
   * spans, a rare poster needs a wide one. Handles the compact forms X uses
   * for large numbers - "72", "429.2K", "3M", "1,234,567".
   */
  function parsePostCount(text) {
    // \s* rather than \s+ before the word: X renders a space, but tolerating
    // its absence costs nothing and guards against a markup change.
    const match = String(text || '').match(/([\d][\d,.]*)\s*([KMB]?)\s*[Pp]osts/);
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    const multiplier = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()];
    return value * multiplier;
  }

  function getPostCount() {
    const header = document.querySelector(SELECTORS.header);
    const primary = document.querySelector(SELECTORS.primary);
    const candidates = [header?.innerText, header?.textContent, primary?.textContent?.slice(0, 3000)]
      .filter(Boolean);
    for (const text of candidates) {
      const count = parsePostCount(text);
      if (count !== null) return count;
    }
    return null;
  }

  // ---- Profile cache -------------------------------------------------------
  //
  // A search page cannot tell us when an account joined or how many posts it
  // has - both live on the profile. The window solver needs both: without a
  // post count it falls back to the widest possible window, which is the
  // worst case for rate limits, and without a join date the search has no
  // floor and no way to validate a result. The old design smuggled the join
  // date through the URL (xs_join), which only ever worked for searches this
  // extension built itself.
  //
  // So the profile page records what it scraped and the search page reads it
  // back. That makes the button work on a from: search the user typed by
  // hand, which is the point of caching rather than passing it along.
  //
  // Two things keep the cache honest. A post count is lifetime, so it only
  // grows and a cached value is always a slight under-estimate; when a scan
  // comes back empty the entry is dropped, because a too-narrow window is
  // exactly what produces empty scans. Entries are keyed per account, so
  // shuffling one person's history then another's never mixes the two - each
  // subject keeps its own join date and post count.
  const PROFILE_CACHE_MAX = 200;

  // getSearchContext() is synchronous - refresh() and scanDiscoveryResults()
  // both need the answer inline - but a storage read is not. So the cache is
  // mirrored into this snapshot, refreshed on load and after every write. A
  // miss means "not read yet", which costs a missing button on the first
  // search after a page load and nothing worse; the MutationObserver-driven
  // refresh retries once the snapshot lands.
  let cacheSnapshot = null;

  function loadProfileCache() {
    readProfileCache(cache => { cacheSnapshot = cache; });
  }

  function readProfileCache(callback) {
    chrome.storage.local.get({ profileCache: {} }, data => {
      const cache = data.profileCache;
      callback(cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {});
    });
  }

  function writeProfileCache(cache) {
    // Bound the store: a long-lived install visiting many profiles would
    // otherwise grow this without limit. Least-recently-seen entries go
    // first, and a fresh profile always wins over an evicted one.
    const entries = Object.entries(cache)
      .sort((a, b) => (b[1]?.seen || 0) - (a[1]?.seen || 0))
      .slice(0, PROFILE_CACHE_MAX);
    chrome.storage.local.set({ profileCache: Object.fromEntries(entries) });
  }

  function cacheProfile(username, joinDate, postCount) {
    if (!username || !joinDate) return;
    readProfileCache(cache => {
      // Keyed by the subject's own handle, so a cache entry can only ever be
      // read back for that same account. Switching which profile you shuffle
      // reads a different key; nothing carries over between subjects.
      // joinDate is normalised to the YYYY-MM-DD string the reader validates:
      // callers hold a Date, and storing one would serialise to a full
      // timestamp that then fails the reader's own format check.
      const day = typeof joinDate === 'string' ? joinDate : formatDate(joinDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      cache[username.toLowerCase()] = { joinDate: day, postCount: postCount ?? null, seen: Date.now() };
      writeProfileCache(cache);
      scheduleRefresh();
    });
  }

  // Synchronous by design - the caller is getSearchContext(), which runs
  // inline inside refresh() and scanDiscoveryResults(). The snapshot is
  // refreshed on load and after every write, so a miss means "not read yet".
  function lookupProfile(username) {
    if (!username || !cacheSnapshot) return null;
    const entry = cacheSnapshot[String(username).toLowerCase()];
    if (!entry || typeof entry.joinDate !== 'string') return null;
    return { joinDate: entry.joinDate, postCount: Number.isFinite(entry.postCount) ? entry.postCount : null };
  }

  // A scan that found nothing may have been squeezed into too narrow a window
  // by a stale post count. Dropping the entry makes the next attempt size
  // from scratch instead of repeating the same too-narrow guess.
  function invalidateProfile(username) {
    if (!username) return;
    readProfileCache(cache => {
      if (!cache[String(username).toLowerCase()]) return;
      delete cache[String(username).toLowerCase()];
      writeProfileCache(cache);
      scheduleRefresh();
    });
  }

  // Explicit forget, for signing out or switching account by hand. The account
  // check on write already prevents cross-account reads, but a user who has
  // logged out should not find the previous account's stats still on disk.
  function clearProfileCache() {
    chrome.storage.local.remove('profileCache');
  }

  function getSearchContext() {
    if (location.pathname !== '/search') return null;
    const params = new URLSearchParams(location.search);
    const username = params.get('q')?.match(/(?:^|\s)from:([A-Za-z0-9_]{1,15})(?=\s|$)/i)?.[1];
    if (!username) return null;

    // The join date may arrive in the URL (a search this extension built) or
    // come from the profile cache (a search the user typed). The URL wins when
    // both are present because it is the value the current scan was sized
    // against; the cache is what makes hand-typed searches work at all.
    const join = params.get('xs_join');
    let joinDate = null;
    let postCount = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(join || '')) {
      const parsed = new Date(`${join}T00:00:00Z`);
      if (Number.isFinite(parsed.getTime()) && formatDate(parsed) === join && parsed <= new Date()) {
        joinDate = parsed;
      }
    }
    if (!joinDate) {
      const found = lookupProfile(username);
      if (!found) return null;
      const parsed = new Date(`${found.joinDate}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || formatDate(parsed) !== found.joinDate || parsed > new Date()) return null;
      joinDate = parsed;
      postCount = found.postCount;
    }
    const postId = params.get('xs_post');
    // The probe is one wide search over the whole history, used to learn
    // which days actually contain posts instead of guessing at a window.
    const probe = params.get('xs_probe') === '1';
    return { username, joinDate, postId: /^\d+$/.test(postId || '') ? postId : null, probe, postCount: postCount ?? null };
  }

  function removeShuffleUI() {
    document.querySelectorAll('.xshuffle-controls').forEach(panel => panel.remove());
  }

  function getSearchToolbarSlot(primary) {
    const form = primary.querySelector(SELECTORS.searchForm);
    if (!form) return null;
    const field = form.getBoundingClientRect();
    const menu = [...primary.querySelectorAll('button, [role="button"]')].find(element => {
      if (element.closest('.xshuffle-controls')) return false;
      const box = element.getBoundingClientRect();
      return !form.contains(element) && box.width && box.height &&
        box.left >= field.right && Math.abs((box.top + box.bottom - field.top - field.bottom) / 2) < 24;
    });
    if (!menu) return null;
    let sibling = menu;
    while (sibling.parentElement && !sibling.parentElement.contains(form)) sibling = sibling.parentElement;
    return sibling.parentElement?.contains(form) ? sibling : null;
  }

  const DEFAULT_OPTIONS = {
    excludeReplies: false,
    mediaOnly: false,
    openSinglePost: false,
    // null = Auto: let the worker size the window from the account's
    // posting rate rather than a fixed number of days.
    windowDays: null,
    rangeStart: '',
    rangeEnd: '',
    // Mirrors the worker's own default. The worker re-clamps and re-defaults
    // regardless, so a stale or absent value here cannot produce a bad delay.
    retryDelayMs: 1000
  };

  /**
   * Search options chosen in the popup. Read straight from storage on each
   * click so a change takes effect without reloading the page.
   */
  function loadOptions() {
    const options = { ...DEFAULT_OPTIONS };
    try {
      const raw = localStorage.getItem('xshuffle:options');
      if (raw) Object.assign(options, JSON.parse(raw));
    } catch {
      // malformed or unavailable storage keeps the defaults
    }
    return {
      excludeReplies: options.excludeReplies === true,
      mediaOnly: options.mediaOnly === true,
      openSinglePost: options.openSinglePost === true,
      rangeStart: /^\d{4}-\d{2}-\d{2}$/.test(options.rangeStart || '') ? options.rangeStart : '',
      rangeEnd: /^\d{4}-\d{2}-\d{2}$/.test(options.rangeEnd || '') ? options.rangeEnd : '',
      // Passed through as typed; the worker owns validation and clamping, so
      // duplicating the rules here would only create a second place for them
      // to drift.
      retryDelayMs: options.retryDelayMs
    };
  }

  function injectShuffleUI(username, joinDate, host, search = false, before = null) {
    const panel = document.createElement('section');
    panel.className = `xshuffle-controls${search ? ' xshuffle-controls--search' : ''}`;
    panel.dataset.username = username;
    panel.setAttribute('aria-label', 'Xshuffle');
    const button = document.createElement('button');
    button.className = 'xshuffle-button';
    button.type = 'button';
    button.textContent = '🎲 Shuffle';
    button.disabled = !joinDate;
    button.dataset.requestId = '';
    if (!joinDate) button.title = 'Join date unavailable';
    button.addEventListener('click', () => {
      if (search ? getSearchContext()?.username !== username : getCurrentProfileUsername() !== username) return;
      const date = search ? getSearchContext()?.joinDate : getJoinDate();
      if (!date) {
        button.disabled = true;
        console.warn('[Xshuffle] Join date could not be read; shuffle cancelled.');
        return;
      }
      delete button.dataset.rateLimited;
      button.disabled = true;
      const requestId = crypto.randomUUID();
      button.dataset.requestId = requestId;
      button.textContent = 'Picking a date…';
      button.title = 'Searching X for a post from this account';
      const recoveryTimer = setTimeout(() => {
        if (button.dataset.requestId !== requestId) return;
        button.disabled = false;
        button.textContent = '🎲 Try again';
        button.title = 'Search stopped responding; try again';
      }, 100000);
      chrome.runtime.sendMessage({
        type: 'xshuffle:discover',
        requestId,
        username,
        joinDate: formatDate(date),
        // A search page has no profile header to read a post count from, so it
        // comes from the cache when one is available. Null here is not fatal:
        // the worker falls back to its widest safe window.
        postCount: getPostCount() ?? lookupProfile(username)?.postCount ?? null,
        options: loadOptions()
      }, response => {
        if (button.dataset.requestId !== requestId) return;
        clearTimeout(recoveryTimer);
        if (chrome.runtime.lastError || !response?.ok) {
          if (response?.rateLimited) {
            showRateLimit(button, response);
          } else {
            button.disabled = false;
            button.textContent = '🎲 Try again';
            button.title = response?.message || 'No searchable posts found; try again';
          }
          console.warn('[Xshuffle] Could not find a post for this account.', response?.message || chrome.runtime.lastError?.message || '');
        }
      });
    });
    panel.append(button);
    if (search) host.insertBefore(panel, before);
    else host.append(panel);
  }

  /**
   * A single-post page (/user/status/123) still shows that author's header, so
   * Shuffle can be offered there too - otherwise choosing "open one post" would
   * strand the user on a page with no way to shuffle again.
   */
  function getPostPageUsername() {
    const match = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
    if (!match) return null;
    return RESERVED.has(match[1].toLowerCase()) ? null : match[1];
  }

  function refresh() {
    if (!enabled) { removeShuffleUI(); return; }
    const username = getCurrentProfileUsername() || getPostPageUsername();
    const header = document.querySelector(SELECTORS.header);
    const primary = document.querySelector(SELECTORS.primary);
    const search = getSearchContext();
    const slot = search && primary && getSearchToolbarSlot(primary);
    if (search && slot?.isConnected) {
      focusDiscoveredPost(primary, search.postId);
      const existing = document.querySelector('.xshuffle-controls');
      if (existing?.dataset.username === search.username && existing.parentElement === slot.parentElement &&
          existing.classList.contains('xshuffle-controls--search')) return;
      removeShuffleUI();
      injectShuffleUI(search.username, search.joinDate, slot.parentElement, true, slot);
      return;
    }
    if (!username || !header || !primary || !primary.contains(header)) {
      removeShuffleUI();
      return;
    }
    const joinDate = getJoinDate();
    const existing = document.querySelector('.xshuffle-controls');
    if (existing && existing.dataset.username === username &&
        existing.parentElement === header &&
        (existing.querySelector('.xshuffle-button').dataset.requestId ||
         existing.querySelector('.xshuffle-button').disabled === !joinDate)) return;
    removeShuffleUI();
    if (!joinDate && warnedFor !== username) {
      console.warn('[Xshuffle] Could not find a visible join date for this profile; Shuffle is disabled.');
      warnedFor = username;
    }
    // A profile visit is the only place these two numbers can be read, so this
    // is where they get recorded. Doing it here rather than on click means a
    // later hand-typed from: search for this account can be served from the
    // cache, which is the whole reason the cache exists.
    if (joinDate) cacheProfile(username, joinDate, getPostCount());
    injectShuffleUI(username, joinDate, header);
  }

  // Reset discovery for a page the scan has just navigated to.
  //
  // Both flags must be cleared together. Clearing only discoveryReported left
  // discoveryStalled set from the previous page, so the next scan ran unstall()
  // against a stale flag and re-opened reporting on a page that had already
  // reported a real result - letting the same page report twice and the worker
  // navigate again over a result the user already had.
  function resetDiscovery() {
    discoveryQuery = location.search;
    discoveryReported = false;
    discoveryStalled = false;
    armDiscoveryTimeout();
  }

  function scheduleRefresh() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      let routeChanged = false;
      if (currentUrl !== location.href) {
        currentUrl = location.href;
        routeChanged = true;
        warnedFor = '';
        if (currentDiscoveryToken() && discoveryQuery !== location.search) {
          resetDiscovery();
        }
      }
      if (routeChanged) {
        loadSettings();
        scanDiscoveryResults();
        return;
      }
      refresh();
      scanDiscoveryResults();
    });
  }

  function focusDiscoveredPost(primary, postId) {
    if (!postId || focusedPostId === postId) return;
    const matchingLink = [...primary.querySelectorAll('a[href*="/status/"]')].find(link => {
      try { return new URL(link.href, location.origin).pathname.endsWith(`/status/${postId}`); }
      catch { return false; }
    });
    const article = matchingLink?.closest('[data-testid="tweet"]');
    if (!article) return;
    focusedPostId = postId;
    article.scrollIntoView({ block: 'center' });
    article.classList.add('xshuffle-found-post');
  }

  // Generic reload errors also occur during outages and failed requests.
  // Only explicit throttling language is evidence of a rate limit.
  const RATE_LIMIT_RE = /rate limit exceeded|you['’]re rate[ -]limited|too many requests/i;

  // How long a search page is given to produce results before the attempt is
  // called a stall. Kept comfortably above a real X search (a couple of
  // seconds) so ordinary variance is never mistaken for a stall, and well
  // below the worker's 90s alarm so a stalled window is retried rather than
  // abandoned. The two are deliberately different numbers answering different
  // questions: this is per-attempt, the alarm is for the whole scan.
  const DISCOVERY_TIMEOUT_MS = 35000;

  function isRateLimited(primary) {
    if (!primary) return false;
    // Results on the page beat any error text. X can leave a stale panel in
    // the DOM while fresh results render, and a post body can contain the
    // words "something went wrong" in a quote or a tweet. Either way there is
    // nothing to be throttled about, so posts are checked first and the panel
    // is only believed when the page is actually empty of them.
    if (primary.querySelector('[data-testid="tweet"]')) return false;
    // Read error headings/alerts, not arbitrary page text or search queries.
    return [...primary.querySelectorAll('h1, h2, h3, [role="heading"], [role="alert"]')]
      .some(panel => RATE_LIMIT_RE.test(panel.innerText || ''));
  }

  // A page that never rendered is not an empty window, and reporting it as one
  // is actively harmful: it burns one of MAX_SCAN_WINDOWS, counts toward the
  // widening threshold, and widens the window - so the slower X gets, the
  // shallower the search, and a scan on a slow connection is likeliest to be
  // the one that gives up. The three stalls needed to trip widening can
  // therefore be spent on 105 seconds of waiting rather than on three real
  // misses.
  //
  // So a stall is reported distinctly and does not touch emptyWindows. The
  // worker retries the SAME window rather than a new one: the window was never
  // disproven, so there is nothing to widen or re-stratify, and retrying it
  // costs exactly the one attempt a genuinely new window would have cost.
  //
  // Crucially the stall is a PROVISIONAL report. A slow page is not a page that
  // will never render, and reporting "stalled" used to latch discoveryReported
  // permanently - so posts that appeared a second later were read by nobody.
  // The page visibly showed results, the worker had already been told the
  // window was stalled, and it was retried for nothing. unstall() therefore
  // re-opens reporting for the rest of this page's life, and the worker treats
  // a late result as authoritative: a scan that has already moved on ignores
  // it, so re-reporting is safe rather than a second scan.
  function reportDiscovery(result) {
    // Read the token fresh: if the SPA has moved to a page with no scan token,
    // there is nothing to report and the old token must not be reused.
    const discoveryToken = currentDiscoveryToken();
    if (!discoveryToken || discoveryReported) return;
    discoveryReported = true;
    // A stall is the one report that can be taken back, so record that it was
    // a stall rather than a verdict on the window.
    discoveryStalled = result?.stalled === true;
    chrome.runtime.sendMessage({
      type: 'xshuffle:scan-result',
      token: discoveryToken,
      post: result
    }, () => void chrome.runtime.lastError);
  }

  // Allow a later, better report from this same page. Only meaningful after a
  // stall: a page that produced posts or a confirmed empty result has already
  // said everything it is going to say, and re-reading it on every mutation
  // would report the same window repeatedly.
  function unstall() {
    if (!discoveryStalled) return;
    discoveryStalled = false;
    discoveryReported = false;
  }

  // Shared by the initial arm and every route change, so the two cannot drift.
  function armDiscoveryTimeout() {
    clearTimeout(discoveryTimeout);
    discoveryTimeout = setTimeout(() => reportDiscovery({ stalled: true }), DISCOVERY_TIMEOUT_MS);
  }

  function scanDiscoveryResults() {
    // A page with no xs_scan is not a scan page - it is either the profile the
    // scan started from or the result page it landed on. Reporting against a
    // stale token there is what re-triggered a finished scan.
    if (!currentDiscoveryToken()) return;
    // Late results on a page already reported as stalled: retract the stall so
    // this scan can report the posts that are actually on screen. This has to
    // come BEFORE the discoveryReported check, or a stalled page would return
    // here and never re-read itself - which is the bug.
    //
    // The worker ignores a result for a scan it has moved on from, so this
    // cannot start a second scan; it can only rescue the one already running.
    unstall();
    if (discoveryReported) return;
    const context = getSearchContext();
    const primary = document.querySelector(SELECTORS.primary);
    if (!context || !primary) return;

    // A throttled search returns an error panel, not results. Report it as a
    // distinct outcome so the worker pauses instead of counting an empty
    // window and immediately firing another search at a limit it has already
    // hit. This has to be checked before the "no results" test below, which
    // would otherwise misread the panel as an ordinary empty window.
    if (isRateLimited(primary)) {
      reportDiscovery({ rateLimited: true });
      return;
    }

    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const posts = new Map();
    for (const article of primary.querySelectorAll('[data-testid="tweet"]')) {
      const dateLink = [...article.querySelectorAll('a[href*="/status/"]')]
        .find(link => link.querySelector('time[datetime]'));
      const time = dateLink?.querySelector('time[datetime]');
      if (!time || !dateLink) continue;
      let path;
      try { path = new URL(dateLink.href, location.origin).pathname; }
      catch { continue; }
      const status = path.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
      const timestamp = new Date(time.getAttribute('datetime'));
      if (!status || status[1].toLowerCase() !== context.username.toLowerCase() || !Number.isFinite(timestamp.getTime())) continue;
      const date = new Date(Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate()));
      if (date < context.joinDate || date > todayUtc) continue;
      posts.set(status[2], { id: status[2], day: formatDate(date) });
    }

    // A probe search is one page of results, so it may only sample the
    // account's history. Report every post it did see and let the worker
    // decide whether that page is representative; it may also want to retry a
    // day already tried, which a single random pick here cannot express.
    if (context.probe) {
      if (posts.size) {
        reportDiscovery({ id: null, day: null, probe: [...posts.values()] });
        return;
      }
      if (/\bNo results for\b/i.test(primary.innerText || '')) {
        reportDiscovery(null);
      }
      return;
    }

    if (posts.size) {
      const matches = [...posts.values()];
      reportDiscovery(matches[Math.floor(Math.random() * matches.length)]);
    } else if (/\bNo results for\b/i.test(primary.innerText || '')) {
      // An empty window can mean the cached post count is stale, which sized
      // the window too narrow. Dropping the entry makes the next shuffle for
      // this account size from its widest safe default rather than repeat the
      // same too-narrow guess. Best effort: a miss here costs nothing.
      invalidateProfile(context.username);
      reportDiscovery(null);
    }
  }

  function releaseRateLimit(button) {
    if (button.dataset.rateLimited !== 'true') return;
    delete button.dataset.rateLimited;
    button.disabled = false;
    button.textContent = '🎲 Try again';
    button.title = 'Search again';
  }

  function showRateLimit(button, response) {
    const mins = Number(response.remaining) || 0;
    button.dataset.rateLimited = 'true';
    button.textContent = '⏳ Rate-Limited';
    button.disabled = true;
    button.title = response.message || `X rate-limited this account. Try again in ${mins} minutes.`;
    if (ignoreRateLimitPause) releaseRateLimit(button);
    // Also recover without a storage event when the pause expires.
    if (mins > 0) {
      const requestId = button.dataset.requestId;
      setTimeout(() => {
        if (button.dataset.requestId === requestId) releaseRateLimit(button);
      }, mins * 60000);
    }
  }

  function loadSettings() {
    const revision = ++settingsRevision;
    const overrideVersion = overrideRevision;
    removeShuffleUI();
    chrome.storage.local.get({ showShuffleUI: true, ignoreRateLimitPause: false }, result => {
      if (revision !== settingsRevision) return;
      enabled = result.showShuffleUI !== false;
      if (overrideVersion === overrideRevision) ignoreRateLimitPause = result.ignoreRateLimitPause === true;
      scheduleRefresh();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.ignoreRateLimitPause) {
        overrideRevision += 1;
        ignoreRateLimitPause = changes.ignoreRateLimitPause.newValue === true;
      }
      if (ignoreRateLimitPause || (changes.cooldownUntil &&
          !(Number(changes.cooldownUntil.newValue) > Date.now()))) {
        document.querySelectorAll('.xshuffle-button').forEach(releaseRateLimit);
      }
    }
    if (area === 'local' && changes.showShuffleUI) {
      settingsRevision += 1;
      enabled = changes.showShuffleUI.newValue !== false;
      scheduleRefresh();
    }
  });
  window.addEventListener('pageshow', loadSettings);
  chrome.runtime.onMessage.addListener(message => {
    const button = [...document.querySelectorAll('.xshuffle-button')]
      .find(candidate => candidate.dataset.requestId === message.requestId);
    if (!button) return;
    if (message?.type === 'xshuffle:complete') {
      if (message.response?.ok) {
        button.textContent = 'Opening post…';
        button.title = 'Opening the selected post';
      } else if (message.response?.rateLimited) {
        showRateLimit(button, message.response);
      } else {
        button.disabled = false;
        button.textContent = '🎲 Try again';
        button.title = message.response?.message || 'Search failed; try again';
      }
      return;
    }
    if (message?.type !== 'xshuffle:progress') return;
    const labels = {
      picking: 'Picking a date…',
      probing: 'Reading their post history…',
      looking: 'Looking for posts…',
      retrying: 'Retrying…',
      waiting: 'Waiting before the next search…',
      widening: 'Widening the date range…'
    };
    if (labels[message.stage]) button.textContent = labels[message.stage];
    if (message.stage === 'waiting' && message.window?.delayMs) {
      // Say how long and why, so a deliberate pause does not read as a hang.
      const secs = (message.window.delayMs / 1000).toFixed(1).replace(/\.0$/, '');
      button.textContent = `Waiting ${secs}s…`;
      button.title = 'Spacing searches out to avoid X rate-limiting you';
    } else if (message.stage === 'looking' && message.window?.start && message.window?.end) {
      button.textContent = `Looking… ${message.window.start}`;
      button.title = `Searching ${message.window.start} through ${message.window.end} (end date excluded)`;
    } else if (labels[message.stage]) {
      button.title = labels[message.stage];
    }
  });
  window.addEventListener('popstate', scheduleRefresh);
  new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (currentDiscoveryToken()) armDiscoveryTimeout();
  loadProfileCache();
  loadSettings();
})();
