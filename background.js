(() => {
  'use strict';

  const pending = new Map();
  const SCAN_TIMEOUT_MS = 90000;
  const MAX_SCAN_WINDOWS = 30;

  // Search-window sizing. The window width is chosen so a random window has
  // roughly TARGET_HIT odds of containing at least one post, given the
  // account's observed posting rate. A prolific account gets a 1-day window;
  // a rare poster gets a wide one. Both ends are clamped so the search stays
  // usable and never scans a range longer than the account's own lifetime.
  //
  // The upper bound is not arbitrary. X serves a fixed result page - measured
  // live at ~15 tweets for one day, seven days and thirty days alike, and
  // scrolling only adds a couple more. A window wider than the point where a
  // full page of results is available therefore buys nothing, and only
  // crowds the top of the range with near-identical dates. MAX_WINDOW_DAYS
  // sits below that cliff on purpose.
  //
  // The f=live parameter below matters as much as the width: without it X
  // serves the relevance-ranked "Top" tab, which was measured returning 7
  // results from the middle of the range and ignoring the date bounds.
  const MIN_WINDOW_DAYS = 1;
  const MAX_WINDOW_DAYS = 90;
  const TARGET_HIT = 0.9;
  const EMPTY_WINDOWS_BEFORE_WIDENING = 3;
  const MAX_WIDENING_STEPS = 2;

  // Stop hammering X. Every scan opens real search requests, and X throttles
  // logged-in accounts that issue them quickly. Once this many scans run
  // inside the cooldown window, further scans are refused until it expires.
  const COOLDOWN_SCANS = 12;
  const COOLDOWN_MS = 15 * 60 * 1000;

  // User-selectable search shaping, mirrored from the popup.
  const DEFAULT_OPTIONS = {
    windowDays: null,      // null = size it automatically from posting rate
    excludeReplies: false,
    mediaOnly: false,
    openSinglePost: false
  };

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
      currentWindow: state.currentWindow,
      windowDays: state.windowDays,
      options: state.options
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

  function monthsBetween(joinDate, today) {
    const a = new Date(`${joinDate}T00:00:00Z`);
    const b = new Date(`${today}T00:00:00Z`);
    if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return 0;
    return Math.max(1, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
      (b.getUTCMonth() - a.getUTCMonth()));
  }

  /**
   * Size the search window from the account's posting rate.
   *
   * Posts spread over monthsActive months give a rate lambda per month. The
   * chance a window of W days contains at least one post is
   * 1 - exp(-(lambda * W/30)); solving that for a TARGET_HIT chance gives the
   * width below. An unknown or zero post count falls back to the widest
   * window, which is the safe direction: a wide search is more likely to
   * find something, just slower.
   */
  function solveWindowDays(postCount, joinDate, today) {
    if (!Number.isFinite(postCount) || postCount <= 0) return MAX_WINDOW_DAYS;
    const months = monthsBetween(joinDate, today);
    if (!months) return MAX_WINDOW_DAYS;
    const perMonth = postCount / months;
    if (!(perMonth > 0)) return MAX_WINDOW_DAYS;
    const days = -Math.log(1 - TARGET_HIT) / (perMonth / 30);
    return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.round(days)));
  }

  /** Extra X search operators requested by the user. */
  function filterClause(options) {
    const parts = [];
    if (options?.excludeReplies) parts.push('filter:replies');
    if (options?.mediaOnly) parts.push('filter:media');
    return parts.length ? ` ${parts.join(' ')}` : '';
  }

  function buildScanUrl(state, token, start, end, probe = false) {
    const query = `from:${state.username} since:${start} until:${end}${filterClause(state.options)}`;
    const params = new URLSearchParams({
      q: query,
      src: 'typed_query',
      f: 'live',
      xs_join: state.joinDate,
      xs_scan: token
    });
    if (probe) params.set('xs_probe', '1');
    return `https://x.com/search?${params.toString()}`;
  }

  /** One search across the account's entire history, to learn its real post days. */
  function buildProbeUrl(state, token) {
    const options = state.options || {};
    const start = options.rangeStart || state.joinDate;
    // Search is inclusive of the start day and exclusive of the end, so ask
    // through tomorrow to cover today.
    const end = options.rangeEnd || tomorrowUtc();
    return buildScanUrl(state, token, start, end, true);
  }

  function chooseScanWindow(state) {
    const windowDays = state.windowDays || MAX_WINDOW_DAYS;
    // A manual range bounds the search outright; otherwise the whole span from
    // the join date to today is fair game.
    const options = state.options || {};
    const rangeStart = options.rangeStart ? new Date(`${options.rangeStart}T00:00:00Z`) : null;
    const rangeEnd = options.rangeEnd ? new Date(`${options.rangeEnd}T00:00:00Z`) : null;
    const join = rangeStart || new Date(`${state.joinDate}T00:00:00Z`);
    const tomorrow = rangeEnd || new Date(`${tomorrowUtc()}T00:00:00Z`);
    if (!(tomorrow > join)) return null;
    const totalDays = Math.max(1, Math.ceil((tomorrow - join) / 86400000));
    const totalWindows = Math.ceil(totalDays / windowDays);
    const available = Array.from({ length: totalWindows }, (_, index) => index)
      .filter(index => !state.triedWindows.has(index));
    if (!available.length) return null;

    // Older posts are weighted up, so a shuffle still feels like time travel
    // rather than landing on yesterday. The weight is the distance from the
    // newest window, so index 0 (oldest) is heaviest.
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
    const startOffset = windowIndex * windowDays;
    const start = new Date(join.getTime() + startOffset * 86400000);
    const end = new Date(Math.min(tomorrow.getTime(), start.getTime() + windowDays * 86400000));
    return { start: formatDate(start), end: formatDate(end) };
  }

  function scanNextWindow(token) {
    const state = pending.get(token);
    if (!state) return;
    if (state.windowsTried >= MAX_SCAN_WINDOWS) {
      finish(token, null, 'No visible posts found in the sampled date ranges; try again.');
      return;
    }

    // The probe search covers the whole history. If it produced nothing, fall
    // back to the windowed scan, which starts from an adaptive width sized by
    // the profile's post count and widens on repeated misses.
    if (!state.currentWindow) {
      const first = chooseScanWindow(state);
      if (!first) {
        finish(token, null, 'No searchable date ranges were available.');
        return;
      }
      state.currentWindow = first;
      state.windowsTried = 1;
      persistState(state, () => {
        if (chrome.runtime.lastError) { finish(token, null, 'Could not save search state.'); return; }
        chrome.tabs.update(state.scanTabId, {
          url: buildScanUrl(state, token, first.start, first.end)
        }, () => {
          if (chrome.runtime.lastError) finish(token, null, 'Could not continue searching X.');
          else progress(state, 'looking', first);
        });
      });
      return;
    }

    // Empty windows in a row mean the posting-rate estimate was optimistic -
    // accounts are bursty, not evenly spread. Widen and re-stratify: clearing
    // triedWindows makes the next pick a fresh draw over the whole span, so a
    // wider window can land in a different era rather than growing in place.
    state.emptyWindows = (state.emptyWindows || 0) + 1;
    if (state.emptyWindows >= EMPTY_WINDOWS_BEFORE_WIDENING &&
        state.windowDays < MAX_WINDOW_DAYS) {
      const widened = Math.min(MAX_WINDOW_DAYS, state.windowDays * 2);
      if (widened > state.windowDays) {
        state.windowDays = widened;
        state.triedWindows.clear();
        state.emptyWindows = 0;
        progress(state, 'widening');
      }
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
        url: buildScanUrl(state, token, window.start, window.end)
      }, () => {
        if (chrome.runtime.lastError) finish(token, null, 'Could not continue searching X.');
        else progress(state, 'looking', window);
      });
    });
  }

  function buildDailySearchUrl(state, post) {
    const date = new Date(`${post.day}T00:00:00Z`);
    const next = new Date(date.getTime() + 86400000);
    const query = `from:${state.username} since:${post.day} until:${formatDate(next)}${filterClause(state.options)}`;
    const params = new URLSearchParams({
      q: query,
      src: 'typed_query',
      f: 'live',
      xs_join: state.joinDate,
      xs_post: post.id
    });
    return `https://x.com/search?${params.toString()}`;
  }

  /** Permalink for a chosen post, used when the user asks for a single page. */
  function buildPostUrl(username, postId) {
    return `https://x.com/${username}/status/${postId}`;
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

  // ---- Rate-limit protection -------------------------------------------
  //
  // X throttles accounts that issue searches quickly, and when it does the
  // extension stops working for that user for a while with no explanation.
  // Counting scans in a rolling window and refusing politely is the cheapest
  // way to stay under the limit without a backend. The count lives in local
  // storage so it survives a service-worker restart.

  function recordScanStart() {
    chrome.storage.local.get({ recentScans: [] }, data => {
      const now = Date.now();
      const recent = (data.recentScans || []).filter(ts => now - ts < COOLDOWN_MS);
      recent.push(now);
      chrome.storage.local.set({ recentScans: recent });
    });
  }

  function cooldownStatus(callback) {
    chrome.storage.local.get({ recentScans: [] }, data => {
      const now = Date.now();
      const recent = (data.recentScans || []).filter(ts => now - ts < COOLDOWN_MS);
      chrome.storage.local.set({ recentScans: recent });
      if (recent.length >= COOLDOWN_SCANS) {
        const waitMinutes = Math.max(1, Math.ceil((COOLDOWN_MS - (now - recent[0])) / 60000));
        callback({
          blocked: true,
          count: recent.length,
          remaining: waitMinutes,
          message: `X rate-limits heavy search use, so Xshuffle pauses after ${COOLDOWN_SCANS} scans per ${COOLDOWN_MS / 60000} minutes. Try again in about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.`
        });
      } else {
        callback({ blocked: false, count: recent.length, remaining: 0, message: '' });
      }
    });
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
      // Single-post mode lands on the permalink itself, so the user reads one
      // post rather than a result list. The content script re-injects on that
      // page, so Shuffle stays available from there.
      const url = state.options?.openSinglePost
        ? buildPostUrl(state.username, post.id)
        : buildDailySearchUrl(state, post);
      chrome.tabs.update(state.targetTabId, { url }, () => {
        if (chrome.runtime.lastError) {
          respond(state, { ok: false, message: 'Could not open the matching page.' });
          return;
        }
        respond(state, { ok: true, singlePost: state.options?.openSinglePost === true });
      });
    });
  }

  function startDiscovery(message, sender, sendResponse) {
    // Refuse early rather than opening searches X will throttle. The count
    // lives in async storage, so gate the rest of the work behind it.
    cooldownStatus(gate => {
      if (gate.blocked) {
        sendResponse({ ok: false, message: gate.message });
        return;
      }
      beginDiscovery(message, sender, sendResponse);
    });
  }

  function beginDiscovery(message, sender, sendResponse) {
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

    const options = sanitiseOptions(message.options);

    // An inverted or empty range is a user error, not a search condition: X
    // would return nothing for it, so refuse before opening any tab rather
    // than burning a scan on a query that cannot match.
    if (options.rangeStart && options.rangeEnd && options.rangeEnd <= options.rangeStart) {
      sendResponse({ ok: false, message: 'The end date must be after the start date.' });
      return;
    }

    // An explicit range from the popup wins; otherwise size the window from
    // the account's own posting rate.
    let windowDays = null;
    if (options.rangeStart && options.rangeEnd) {
      const start = new Date(`${options.rangeStart}T00:00:00Z`);
      const end = new Date(`${options.rangeEnd}T00:00:00Z`);
      if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start < end) {
        // An explicit range is the user's decision, so it is not clamped to the
        // automatic maximum - but it is split into windows no wider than
        // MAX_WINDOW_DAYS so a single search never asks X for more than it
        // will return.
        const span = Math.ceil((end - start) / 86400000);
        windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, span));
      }
    }
    if (windowDays === null) {
      windowDays = solveWindowDays(message.postCount, joinDate, formatDate(new Date()));
    }

    const token = crypto.randomUUID();
    const state = {
      token, targetTabId, sourceUrl, username, joinDate,
      requestId: message.requestId, sendResponse, scanTabId: undefined,
      windowsTried: 0, triedWindows: new Set(), currentWindow: null,
      windowDays, options, baseWindowDays: windowDays, emptyWindows: 0
    };
    pending.set(token, state);
    recordScanStart();
    progress(state, 'picking');

    // Open the probe first: one search across the account's whole history,
    // which returns the days that actually contain posts. Falling back to the
    // windowed scan only happens if that returns nothing.
    const probeUrl = buildProbeUrl(state, token);
    persistState(state, () => {
      if (chrome.runtime.lastError) { finish(token, null, 'Could not save search state.'); return; }
      chrome.tabs.create({ url: probeUrl, active: false }, tab => {
        if (chrome.runtime.lastError || !tab?.id) {
          finish(token, null, 'Could not open an X search tab.');
          return;
        }
        state.scanTabId = tab.id;
        persistState(state, () => {
          if (chrome.runtime.lastError) { finish(token, null, 'Could not save search state.'); return; }
          chrome.alarms.create(timeoutAlarm(token), { when: Date.now() + SCAN_TIMEOUT_MS });
          progress(state, 'probing');
        });
      });
    });
  }

  function sanitiseOptions(raw) {
    const options = raw && typeof raw === 'object' ? raw : {};
    return {
      windowDays: null,
      excludeReplies: options.excludeReplies === true,
      mediaOnly: options.mediaOnly === true,
      openSinglePost: options.openSinglePost === true,
      rangeStart: /^\d{4}-\d{2}-\d{2}$/.test(options.rangeStart || '') ? options.rangeStart : null,
      rangeEnd: /^\d{4}-\d{2}-\d{2}$/.test(options.rangeEnd || '') ? options.rangeEnd : null
    };
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

      // A probe result carries the account's real post days. Validate every
      // one, then pick among them - this replaces guessing a window width from
      // an estimated posting rate, which the profile post count cannot support
      // because that count includes replies and media X will not search.
      if (Array.isArray(id === null ? message.post.probe : null)) {
        const parsedJoin = new Date(`${state.joinDate}T00:00:00Z`);
        const today = new Date();
        const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        const options = state.options || {};
        const rangeStart = options.rangeStart ? new Date(`${options.rangeStart}T00:00:00Z`) : null;
        const rangeEnd = options.rangeEnd ? new Date(`${options.rangeEnd}T00:00:00Z`) : null;
        const valid = message.post.probe.filter(post => {
          const parsedDay = new Date(`${post?.day}T00:00:00Z`);
          if (!/^\d+$/.test(post?.id || '') || !/^\d{4}-\d{2}-\d{2}$/.test(post?.day || '')) return false;
          if (!Number.isFinite(parsedDay.getTime()) || formatDate(parsedDay) !== post.day) return false;
          if (parsedDay < parsedJoin || parsedDay > todayUtc) return false;
          if (rangeStart && parsedDay < rangeStart) return false;
          if (rangeEnd && parsedDay >= rangeEnd) return false;
          return true;
        });
        if (!valid.length) {
          // The probe came back empty or unusable: fall back to the windowed
          // scan, which at least narrows the search over several attempts.
          state.probing = false;
          finish(message.token, null, 'X returned no searchable posts for this account.');
          sendResponse({ ok: false });
          return;
        }
        // Weight older posts up so a shuffle still favours the back catalogue.
        // The probe search runs newest first, so sort oldest-first first -
        // otherwise the weighting below would favour the most recent post,
        // which is the opposite of what a shuffle is for.
        const ordered = [...valid].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
        const weights = ordered.map((_, index) => ordered.length - index);
        const totalWeight = weights.reduce((sum, value) => sum + value, 0);
        let draw = Math.random() * totalWeight;
        let chosen = ordered[ordered.length - 1];
        for (let i = 0; i < ordered.length; i++) {
          draw -= weights[i];
          if (draw < 0) { chosen = ordered[i]; break; }
        }
        finish(message.token, { id: chosen.id, day: chosen.day, found: valid.length });
        sendResponse({ ok: true });
        return;
      }

      const parsedDay = new Date(`${day}T00:00:00Z`);
      const parsedJoin = new Date(`${state.joinDate}T00:00:00Z`);
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      if (!/^\d+$/.test(id || '') || !/^\d{4}-\d{2}-\d{2}$/.test(day || '') ||
          !Number.isFinite(parsedDay.getTime()) || formatDate(parsedDay) !== day ||
          parsedDay < parsedJoin || parsedDay > todayUtc ||
          !state.currentWindow ||
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
