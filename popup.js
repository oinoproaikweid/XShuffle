const toggle = document.getElementById("show-shuffle-ui");
const status = document.getElementById("toggle-status");
function setTheme(theme) {
  document.body.dataset.theme = theme;
}

function inferThemeFromBackground(color) {
  const match = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return null;
  const [red, green, blue] = match.slice(1).map(Number);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  if (luminance > 0.72) return "light";
  return luminance > 0.025 ? "dim" : "dark";
}

async function syncThemeWithActiveTab() {
  setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://x.com/")) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const root = document.documentElement;
        const declared = (root.getAttribute("data-color-mode") || root.getAttribute("data-theme") || "").toLowerCase();
        if (["light", "dim", "dark"].includes(declared)) return { theme: declared };

        let element = document.querySelector('[data-testid="primaryColumn"]') || document.body;
        while (element) {
          const background = getComputedStyle(element).backgroundColor;
          if (background && background !== "transparent" && !background.endsWith(", 0)")) return { background };
          element = element.parentElement;
        }
        return { background: getComputedStyle(root).backgroundColor };
      }
    });
    const { theme, background } = result?.result || {};
    if (["light", "dim", "dark"].includes(theme)) setTheme(theme);
    else setTheme(inferThemeFromBackground(background) || "light");
  } catch {
    // Keep the system-theme fallback when the active tab is not readable.
  }
}

syncThemeWithActiveTab();

function updateStatus(enabled) {
  toggle.checked = enabled;
  status.textContent = enabled ? "Enabled" : "Hidden";
}

chrome.storage.local.get({ showShuffleUI: true }, ({ showShuffleUI }) => {
  updateStatus(showShuffleUI);
});

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  updateStatus(enabled);
  chrome.storage.local.set({ showShuffleUI: enabled });
});

document.getElementById("close-popup").addEventListener("click", () => window.close());

// ---- Search options -------------------------------------------------------
//
// The content script reads these from page-local storage on each click, so the
// values must live under the "xshuffle:options" key on x.com pages. The popup
// cannot write page storage directly, so it stores them in extension storage and
// the content script mirrors them across on load.

const windowDaysInput = document.getElementById("opt-window-days");
const windowDaysValue = document.getElementById("opt-window-days-value");
const windowHint = document.getElementById("window-hint");

const optionFields = {
  excludeReplies: document.getElementById("opt-exclude-replies"),
  mediaOnly: document.getElementById("opt-media-only"),
  openSinglePost: document.getElementById("opt-single-post")
};

// ---- Retry delay ---------------------------------------------------------
//
// A typed millisecond value rather than a slider: the useful settings are 0
// (as fast as possible) and "long enough to stay well under a limit", and a
// slider over that range is either mostly dead space or too coarse to aim
// with. The worker re-validates and clamps whatever arrives, so a bad value
// here can never wedge a scan.
const RETRY_DELAY_DEFAULT_MS = 1000;
const RETRY_DELAY_MAX_MS = 60000;
const retryDelayInput = document.getElementById("opt-retry-delay");
const retryDelayValue = document.getElementById("opt-retry-delay-value");
const retryDelayHint = document.getElementById("retry-delay-hint");

/** Clamp to what the worker accepts, so the readout matches what will happen. */
function normaliseRetryDelay(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return RETRY_DELAY_DEFAULT_MS;
  return Math.min(RETRY_DELAY_MAX_MS, Math.round(value));
}

function describeDelay(ms) {
  if (ms === 0) return "none";
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  return `${Number.isInteger(secs) ? secs : secs.toFixed(1)}s`;
}

function renderRetryDelay() {
  const ms = normaliseRetryDelay(retryDelayInput.value);
  retryDelayValue.textContent = describeDelay(ms);
  retryDelayInput.setAttribute("aria-valuetext", describeDelay(ms));
  // Explain the consequence, because 0 and 1000 are very different choices and
  // the field itself does not convey that.
  retryDelayHint.textContent = ms === 0
    ? "No delay: searches fire as fast as X will answer them. Fastest, and the most likely to be rate-limited."
    : `Waiting ${describeDelay(ms)} before each retry search. The first search is never delayed. A scan trying ${ms >= 2000 ? "many date ranges" : "several date ranges"} adds roughly ${describeDelay(ms * 29)} at worst.`;
}

retryDelayInput.addEventListener("input", renderRetryDelay);
retryDelayInput.addEventListener("change", () => {
  retryDelayInput.value = String(normaliseRetryDelay(retryDelayInput.value));
  renderRetryDelay();
  saveOptions();
});
renderRetryDelay();

// A slider needs an "off" position, and range inputs have no natural one, so
// Auto sits at the far left as its own step before the day counts begin.
const AUTO_WINDOW_DAYS = 0;
const windowDaysToDays = value => (value === AUTO_WINDOW_DAYS ? null : value);

function describeWindow(days) {
  if (days === null) return "Auto";
  return days === 1 ? "1 day" : `${days} days`;
}

function renderWindow() {
  const days = windowDaysToDays(Number(windowDaysInput.value));
  windowDaysValue.textContent = describeWindow(days);
  windowDaysInput.setAttribute("aria-valuetext", describeWindow(days));
  windowHint.textContent = days === null
    ? "Auto sizes the window from how often the account posts. X returns about 15 posts per search, so a wider window finds older posts but searches more."
    : `Each search covers ${describeWindow(days)}. X returns about 15 posts per search, so a wider window finds older posts but searches more.`;
}

function currentOptions() {
  return {
    excludeReplies: optionFields.excludeReplies.checked,
    mediaOnly: optionFields.mediaOnly.checked,
    openSinglePost: optionFields.openSinglePost.checked,
    windowDays: windowDaysToDays(Number(windowDaysInput.value)),
    retryDelayMs: normaliseRetryDelay(retryDelayInput.value)
  };
}

function applyOptions(options) {
  for (const [key, field] of Object.entries(optionFields)) {
    if (!field) continue;
    if (typeof options[key] === "boolean") field.checked = options[key];
  }
  // Accept the old stored shape so an existing profile keeps working, then
  // move it onto the slider.
  if (typeof options.windowDays === "number" && options.windowDays > 0) {
    windowDaysInput.value = String(Math.min(90, Math.max(1, Math.round(options.windowDays))));
  } else if (options.rangeStart && options.rangeEnd) {
    const span = Math.round(
      (new Date(`${options.rangeEnd}T00:00:00Z`) - new Date(`${options.rangeStart}T00:00:00Z`)) / 86400000);
    if (Number.isFinite(span) && span > 0) {
      windowDaysInput.value = String(Math.min(90, Math.max(1, span)));
    }
  }
  // An absent or invalid stored delay keeps the default rather than showing an
  // empty field, which would read as "unset" and save back as the default
  // anyway - just less clearly.
  if (Number.isFinite(Number(options.retryDelayMs))) {
    retryDelayInput.value = String(normaliseRetryDelay(options.retryDelayMs));
  }
  renderWindow();
  renderRetryDelay();
}

function saveOptions() {
  const options = currentOptions();
  chrome.storage.local.set({ searchOptions: options });
  // Mirror into the active x.com tab so the content script sees it at once.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
    if (!tab?.id || !tab.url?.startsWith("https://x.com/")) return;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: value => localStorage.setItem("xshuffle:options", JSON.stringify(value)),
      args: [options]
    }).catch(() => {
      // The content script also reads extension storage on load, so a failed
      // injection here is not fatal.
    });
  });
}

chrome.storage.local.get({ searchOptions: null }, ({ searchOptions }) => {
  if (searchOptions) applyOptions(searchOptions);
});

for (const field of Object.values(optionFields)) {
  if (field) field.addEventListener("change", saveOptions);
}

// A range input fires "input" while dragging, so save on release but keep the
// readout live.
windowDaysInput.addEventListener("input", renderWindow);
windowDaysInput.addEventListener("change", saveOptions);
renderWindow();

// ---- Rate-limit notice -----------------------------------------------------
//
// The worker decides when to pause and stores an expiry, so the popup only
// renders it. There is no scan budget to count down any more: a pause exists
// because X rate-limited the account, and the copy says so rather than
// implying Xshuffle is throttling the user on its own.

const notice = document.getElementById("rate-limit-notice");
const ignoreHint = document.getElementById("rate-limit-hint");

function renderNotice(data) {
  const remainingMs = (Number(data.cooldownUntil) || 0) - Date.now();
  if (remainingMs <= 0) return;
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  notice.hidden = false;
  notice.textContent = data.cooldownReason === 'rate-limited'
    ? `X rate-limited this account. Xshuffle is paused for ${minutes} more minute${minutes === 1 ? '' : 's'} rather than searching again and making it worse.`
    : `A search failed to load, so Xshuffle is paused for ${minutes} more minute${minutes === 1 ? '' : 's'}.`;
  // The override applies only to a limit X reported, never to the short pause
  // after a failed load. Say which one is in force rather than letting the
  // checkbox look universal.
  ignoreHint.textContent = data.cooldownReason === 'rate-limited'
    ? 'On: Xshuffle will search straight through this pause. The countdown keeps running, and X may hold the limit for longer.'
    : 'This override applies only when X rate-limits you. It does not skip the pause that follows a search which failed to load.';
}

chrome.storage.local.get({ cooldownUntil: 0, cooldownReason: '' }, renderNotice);

// Keep the countdown and the override wording live while the popup is open.
// storage.onChanged fires when the worker sets or clears the pause, so this
// needs no polling timer of its own.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.cooldownUntil && !changes.cooldownReason) return;
  chrome.storage.local.get({ cooldownUntil: 0, cooldownReason: '' }, renderNotice);
});

// ---- Rate-limit override -------------------------------------------------

// The worker reads ignoreRateLimitPause from extension storage on every
// click, so unlike the search options this needs no copy mirrored into page
// storage - there is no content-script copy to keep in sync.
const ignoreRateLimit = document.getElementById("opt-ignore-rate-limit");

ignoreRateLimit.addEventListener("change", () => {
  chrome.storage.local.set({ ignoreRateLimitPause: ignoreRateLimit.checked === true });
});

chrome.storage.local.get({ ignoreRateLimitPause: false }, ({ ignoreRateLimitPause }) => {
  ignoreRateLimit.checked = ignoreRateLimitPause === true;
});
