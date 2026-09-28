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

const optionFields = {
  excludeReplies: document.getElementById("opt-exclude-replies"),
  mediaOnly: document.getElementById("opt-media-only"),
  openSinglePost: document.getElementById("opt-single-post"),
  rangeStart: document.getElementById("opt-range-start"),
  rangeEnd: document.getElementById("opt-range-end")
};

function currentOptions() {
  return {
    excludeReplies: optionFields.excludeReplies.checked,
    mediaOnly: optionFields.mediaOnly.checked,
    openSinglePost: optionFields.openSinglePost.checked,
    rangeStart: optionFields.rangeStart.value,
    rangeEnd: optionFields.rangeEnd.value
  };
}

function applyOptions(options) {
  for (const [key, field] of Object.entries(optionFields)) {
    if (!field) continue;
    if (typeof options[key] === "boolean") field.checked = options[key];
    else if (typeof options[key] === "string") field.value = options[key];
  }
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
