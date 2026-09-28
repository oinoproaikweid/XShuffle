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

  function getSearchContext() {
    if (location.pathname !== '/search') return null;
    const params = new URLSearchParams(location.search);
    const join = params.get('xs_join');
    const username = params.get('q')?.match(/(?:^|\s)from:([A-Za-z0-9_]{1,15})(?=\s|$)/i)?.[1];
    if (!username || !/^\d{4}-\d{2}-\d{2}$/.test(join || '')) return null;
    const joinDate = new Date(`${join}T00:00:00Z`);
    if (!Number.isFinite(joinDate.getTime()) || formatDate(joinDate) !== join || joinDate > new Date()) return null;
    const postId = params.get('xs_post');
    return { username, joinDate, postId: /^\d+$/.test(postId || '') ? postId : null };
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
        joinDate: formatDate(date)
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

  function refresh() {
    if (!enabled) { removeShuffleUI(); return; }
    const username = getCurrentProfileUsername();
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
      looking: 'Looking for posts…',
      retrying: 'Retrying…'
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
