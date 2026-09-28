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
    windowDays: windowDaysToDays(Number(windowDaysInput.value))
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
  renderWindow();
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

// ---- Rate-limit warning ---------------------------------------------------

const notice = document.getElementById("rate-limit-notice");
const COOLDOWN_MS = 15 * 60 * 1000;
const COOLDOWN_SCANS = 12;

chrome.storage.local.get({ recentScans: [] }, ({ recentScans }) => {
  const now = Date.now();
  const recent = (recentScans || []).filter(ts => now - ts < COOLDOWN_MS);
  const remaining = COOLDOWN_SCANS - recent.length;
  if (remaining <= 3) {
    notice.hidden = false;
    notice.textContent = remaining > 0
      ? `X rate-limits heavy searching, so Xshuffle pauses after ${COOLDOWN_SCANS} scans every ${COOLDOWN_MS / 60000} minutes. ${remaining} scan${remaining === 1 ? "" : "s"} left before the pause.`
      : "Xshuffle is paused to avoid an X rate limit. Try again shortly.";
  }
});
