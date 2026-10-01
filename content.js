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
  let currentUrl = location.href;
  let pending = false;
  let settingsRevision = 0;
  let warnedFor = '';
  const discoveryToken = new URLSearchParams(location.search).get('xs_scan');
  let discoveryReported = false;
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

  function getSearchContext() {
    if (location.pathname !== '/search') return null;
    const params = new URLSearchParams(location.search);
    const join = params.get('xs_join');
    const username = params.get('q')?.match(/(?:^|\s)from:([A-Za-z0-9_]{1,15})(?=\s|$)/i)?.[1];
    if (!username || !/^\d{4}-\d{2}-\d{2}$/.test(join || '')) return null;
    const joinDate = new Date(`${join}T00:00:00Z`);
    if (!Number.isFinite(joinDate.getTime()) || formatDate(joinDate) !== join || joinDate > new Date()) return null;
    const postId = params.get('xs_post');
    // The probe is one wide search over the whole history, used to learn
    // which days actually contain posts instead of guessing at a window.
    const probe = params.get('xs_probe') === '1';
    return { username, joinDate, postId: /^\d+$/.test(postId || '') ? postId : null, probe };
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
    // null means Auto: let the worker size the window from the account's
    // posting rate rather than a fixed number of days.
    windowDays: null,
    rangeStart: '',
    rangeEnd: ''
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
      rangeEnd: /^\d{4}-\d{2}-\d{2}$/.test(options.rangeEnd || '') ? options.rangeEnd : ''
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
        postCount: getPostCount(),
        options: loadOptions()
      }, response => {
        if (button.dataset.requestId !== requestId) return;
        clearTimeout(recoveryTimer);
        if (chrome.runtime.lastError || !response?.ok) {
          button.disabled = false;
          button.textContent = '🎲 Try again';
          button.title = response?.message || 'No searchable posts found; try again';
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
      console.warn(`[Xshuffle] Could not find a visible join date for @${username}; Shuffle is disabled.`);
      warnedFor = username;
    }
    injectShuffleUI(username, joinDate, header);
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
        if (discoveryToken && discoveryQuery !== location.search) {
          discoveryQuery = location.search;
          discoveryReported = false;
          clearTimeout(discoveryTimeout);
          discoveryTimeout = setTimeout(() => reportDiscovery(null), 35000);
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

  // X signals a throttled search with an error panel rather than an empty
  // result list: a "Something went wrong" heading beside a Reload button,
  // with no tweets and no "No results for ..." line. Left undetected that
  // panel is indistinguishable from a genuinely empty date window, so the
  // scan treats it as a miss, widens the window and searches again - which
  // is the exact behaviour that provokes the limit in the first place.
  //
  // The Reload button is what makes this a positive signal rather than a
  // guess: a real empty result set says "No results", so requiring the
  // error panel's own reload affordance keeps the two cases apart.
  const RATE_LIMIT_RE = /something went wrong|rate limit exceeded|you're rate limited|too many requests/i;
  const RATE_LIMIT_RELOAD_RE = /^\s*reload\s*$/i;

  function isRateLimited(primary) {
    if (!primary) return false;
    // Results on the page beat any error text. X can leave a stale panel in
    // the DOM while fresh results render, and a post body can contain the
    // words "something went wrong" in a quote or a tweet. Either way there is
    // nothing to be throttled about, so posts are checked first and the panel
    // is only believed when the page is actually empty of them.
    if (primary.querySelector('[data-testid="tweet"]')) return false;
    const scope = primary.innerText || '';
    if (!RATE_LIMIT_RE.test(scope)) return false;
    // Require the panel's own Reload control so an unrelated "something went
    // wrong" string elsewhere on the page cannot trip a pause.
    const buttons = [...primary.querySelectorAll('button, [role="button"]')];
    return buttons.some(button => RATE_LIMIT_RELOAD_RE.test((button.innerText || '').trim()));
  }

  function reportDiscovery(result) {
    if (!discoveryToken || discoveryReported) return;
    discoveryReported = true;
    chrome.runtime.sendMessage({
      type: 'xshuffle:scan-result',
      token: discoveryToken,
      post: result
    }, () => void chrome.runtime.lastError);
  }

  function scanDiscoveryResults() {
    if (!discoveryToken || discoveryReported) return;
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
      reportDiscovery(null);
    }
  }

  function loadSettings() {
    const revision = ++settingsRevision;
    removeShuffleUI();
    chrome.storage.local.get({ showShuffleUI: true }, result => {
      if (revision !== settingsRevision) return;
      enabled = result.showShuffleUI !== false;
      scheduleRefresh();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
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
      widening: 'Widening the date range…'
    };
    if (labels[message.stage]) button.textContent = labels[message.stage];
    if (message.stage === 'looking' && message.window?.start && message.window?.end) {
      button.textContent = `Looking… ${message.window.start}`;
      button.title = `Searching ${message.window.start} through ${message.window.end} (end date excluded)`;
    } else if (labels[message.stage]) {
      button.title = labels[message.stage];
    }
  });
  window.addEventListener('popstate', scheduleRefresh);
  new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (discoveryToken) discoveryTimeout = setTimeout(() => reportDiscovery(null), 35000);
  loadSettings();
})();
