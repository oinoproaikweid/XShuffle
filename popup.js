const toggle = document.getElementById("show-shuffle-ui");
const status = document.getElementById("toggle-status");
// Optional tip link. Set to a URL to enable it, or leave empty to hide the
// control entirely. An empty string removes the button from the popup.
const TIP_URL = "";

const tipLink = document.getElementById("tip-link");
if (TIP_URL) {
  tipLink.href = TIP_URL;
} else {
  tipLink.remove();
}

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
