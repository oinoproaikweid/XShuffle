(() => {
  'use strict';

  const pending = new Map();
  const SCAN_TIMEOUT_MS = 90000;
  const SCAN_WINDOW_DAYS = 7;
  const MAX_SCAN_WINDOWS = 30;

  function stateKey(token) { return `xshuffle:${token}`; }
  function timeoutAlarm(token) { return `xshuffle-timeout:${token}`; }

  function serializableState(state) {
    return {
      token: state.token,
      targetTabId: state.targetTabId,
      sourceUrl: state.sourceUrl,
      username: state.username,
      joinDate: state.joinDate,
      requestId: state.requestId,
      scanTabId: state.scanTabId,
      windowsTried: state.windowsTried,
      triedWindows: [...state.triedWindows],
      currentWindow: state.currentWindow
    };
  }

  function persistState(state, callback = () => {}) {
    chrome.storage.session.set({ [stateKey(state.token)]: serializableState(state) }, callback);
  }

  function loadState(token, callback) {
    const cached = pending.get(token);
    if (cached) { callback(cached); return; }
    chrome.storage.session.get(stateKey(token), result => {
      const saved = result[stateKey(token)];
      if (!saved) { callback(null); return; }
      const state = { ...saved, triedWindows: new Set(saved.triedWindows || []), sendResponse: null };
      pending.set(token, state);
      callback(state);
    });
  }

  function respond(state, response) {
    if (typeof state.sendResponse === 'function') state.sendResponse(response);
    chrome.tabs.sendMessage(state.targetTabId, {
      type: 'xshuffle:complete', requestId: state.requestId, response
    }, () => void chrome.runtime.lastError);
  }

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function tomorrowUtc() {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return formatDate(tomorrow);
  }

  function buildScanUrl(username, joinDate, token, start, end) {
    const query = `from:${username} since:${start} until:${end}`;
    const params = new URLSearchParams({
      q: query,
      src: 'typed_query',
      f: 'live',
      xs_join: joinDate,
      xs_scan: token
    });
    return `https://x.com/search?${params.toString()}`;
  }

  function chooseScanWindow(state) {
    const join = new Date(`${state.joinDate}T00:00:00Z`);
    const tomorrow = new Date(`${tomorrowUtc()}T00:00:00Z`);
    const totalDays = Math.max(1, Math.ceil((tomorrow - join) / 86400000));
    const totalWindows = Math.ceil(totalDays / SCAN_WINDOW_DAYS);
    const available = Array.from({ length: totalWindows }, (_, index) => index)
      .filter(index => !state.triedWindows.has(index));
    if (!available.length) return null;
    const totalWeight = available.reduce((sum, index) => sum + totalWindows - index, 0);
    let draw = Math.random() * totalWeight;
    let windowIndex = available[available.length - 1];
    for (const index of available) {
      draw -= totalWindows - index;
      if (draw < 0) {
        windowIndex = index;
        break;
      }
    }
    state.triedWindows.add(windowIndex);
    const startOffset = windowIndex * SCAN_WINDOW_DAYS;
    const start = new Date(join.getTime() + startOffset * 86400000);
    const end = new Date(Math.min(tomorrow.getTime(), start.getTime() + SCAN_WINDOW_DAYS * 86400000));
    return { start: formatDate(start), end: formatDate(end) };
  }

  function scanNextWindow(token) {
    const state = pending.get(token);
    if (!state) return;
    if (state.windowsTried >= MAX_SCAN_WINDOWS) {
      finish(token, null, 'No visible posts found in the sampled date ranges; try again.');
      return;
    }
    progress(state, 'retrying');
    const window = chooseScanWindow(state);
    if (!window) {
      finish(token, null, 'No visible posts found in the sampled date ranges; try again.');
      return;
    }
    state.windowsTried += 1;
    state.currentWindow = window;
    persistState(state, () => {
      if (chrome.runtime.lastError) { finish(token, null, 'Could not save search state.'); return; }
      chrome.tabs.update(state.scanTabId, {
        url: buildScanUrl(state.username, state.joinDate, token, window.start, window.end)
      }, () => {
        if (chrome.runtime.lastError) finish(token, null, 'Could not continue searching X.');
        else progress(state, 'looking', window);
      });
    });
  }

  function buildDailySearchUrl(username, joinDate, post) {
    const date = new Date(`${post.day}T00:00:00Z`);
    const next = new Date(date.getTime() + 86400000);
    const query = `from:${username} since:${post.day} until:${formatDate(next)}`;
    const params = new URLSearchParams({
      q: query,
      src: 'typed_query',
      f: 'live',
      xs_join: joinDate,
      xs_post: post.id
    });
    return `https://x.com/search?${params.toString()}`;
  }

  function profileUsername(url) {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://x.com' || parsed.pathname === '/search') return null;
      const username = parsed.pathname.split('/').filter(Boolean)[0];
      return /^[A-Za-z0-9_]{1,15}$/.test(username || '') ? username.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function tabUsername(url) {
    const profile = profileUsername(url);
    if (profile) return profile;
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://x.com' || parsed.pathname !== '/search') return null;
      return parsed.searchParams.get('q')?.match(/(?:^|\s)from:([A-Za-z0-9_]{1,15})(?=\s|$)/i)?.[1]?.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function progress(state, stage, window) {
    chrome.tabs.sendMessage(state.targetTabId, { type: 'xshuffle:progress', requestId: state.requestId, stage, window }, () => void chrome.runtime.lastError);
  }

  function finish(token, post, message) {
    const state = pending.get(token);
    if (!state) return;
    pending.delete(token);
    chrome.storage.session.remove(stateKey(token));
    chrome.alarms.clear(timeoutAlarm(token));
    if (state.scanTabId !== undefined) {
      chrome.tabs.remove(state.scanTabId, () => void chrome.runtime.lastError);
    }

    if (!post) {
      respond(state, { ok: false, message: message || 'X search found no visible posts for this account.' });
      return;
    }

    chrome.tabs.get(state.targetTabId, target => {
      if (chrome.runtime.lastError || tabUsername(target?.url) !== state.username.toLowerCase()) {
        respond(state, { ok: false, message: 'The profile changed while searching; click Shuffle again.' });
        return;
      }
      chrome.tabs.update(state.targetTabId, { url: buildDailySearchUrl(state.username, state.joinDate, post) }, () => {
        if (chrome.runtime.lastError) {
          respond(state, { ok: false, message: 'Could not open the matching search page.' });
          return;
        }
        respond(state, { ok: true });
      });
    });
  }

  function startDiscovery(message, sender, sendResponse) {
    const username = message.username;
    const joinDate = message.joinDate;
    const targetTabId = sender.tab?.id;
    const sourceUrl = sender.tab?.url;
    const parsedJoin = new Date(`${joinDate}T00:00:00Z`);
    if (!targetTabId || !sourceUrl?.startsWith('https://x.com/') ||
        !/^[A-Za-z0-9_]{1,15}$/.test(username || '') ||
        !/^\d{4}-\d{2}-\d{2}$/.test(joinDate || '') ||
        !Number.isFinite(parsedJoin.getTime()) || formatDate(parsedJoin) !== joinDate || parsedJoin > new Date()) {
      sendResponse({ ok: false, message: 'Profile details were unavailable; refresh and try again.' });
      return;
    }

    const token = crypto.randomUUID();
    const state = { token, targetTabId, sourceUrl, username, joinDate, requestId: message.requestId, sendResponse, scanTabId: undefined, windowsTried: 0, triedWindows: new Set() };
    pending.set(token, state);
    progress(state, 'picking');
    const firstWindow = chooseScanWindow(state);
    if (!firstWindow) {
      finish(token, null, 'No searchable date ranges were available.');
      return;
    }
    state.currentWindow = firstWindow;
    state.windowsTried = 1;
    persistState(state, () => {
      if (chrome.runtime.lastError) { finish(token, null, 'Could not save search state.'); return; }
      chrome.tabs.create({ url: buildScanUrl(username, joinDate, token, firstWindow.start, firstWindow.end), active: false }, tab => {
        if (chrome.runtime.lastError || !tab?.id) {
          finish(token, null, 'Could not open an X search tab.');
          return;
        }
        state.scanTabId = tab.id;
        persistState(state, () => {
          if (chrome.runtime.lastError) { finish(token, null, 'Could not save search state.'); return; }
          chrome.alarms.create(timeoutAlarm(token), { when: Date.now() + SCAN_TIMEOUT_MS });
          progress(state, 'looking', firstWindow);
        });
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'xshuffle:discover') {
      startDiscovery(message, sender, sendResponse);
      return true;
    }
    if (message?.type !== 'xshuffle:scan-result' || !sender.tab?.id) return false;
    loadState(message.token, state => {
      if (!state || state.scanTabId !== sender.tab.id || !sender.url?.startsWith('https://x.com/search?')) {
        sendResponse({ ok: false, message: 'This scan is no longer active.' });
        return;
      }
      if (!message.post) {
        scanNextWindow(message.token);
        sendResponse({ ok: true });
        return;
      }

      const { id, day } = message.post;
      const parsedDay = new Date(`${day}T00:00:00Z`);
      const parsedJoin = new Date(`${state.joinDate}T00:00:00Z`);
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      if (!/^\d+$/.test(id || '') || !/^\d{4}-\d{2}-\d{2}$/.test(day || '') ||
          !Number.isFinite(parsedDay.getTime()) || formatDate(parsedDay) !== day ||
          parsedDay < parsedJoin || parsedDay > todayUtc ||
          parsedDay < new Date(`${state.currentWindow.start}T00:00:00Z`) ||
          parsedDay >= new Date(`${state.currentWindow.end}T00:00:00Z`)) {
        finish(message.token, null, 'X search returned a post with an unusable date.');
        sendResponse({ ok: false });
        return;
      }
      finish(message.token, { id, day });
      sendResponse({ ok: true });
    });
    return true;
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    const prefix = 'xshuffle-timeout:';
    if (!alarm.name.startsWith(prefix)) return;
    const token = alarm.name.slice(prefix.length);
    loadState(token, state => {
      if (state) finish(token, null, 'X search took too long; try again.');
      else chrome.alarms.clear(alarm.name);
    });
  });
})();
