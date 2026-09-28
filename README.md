# Xshuffle

Xshuffle adds a small Shuffle button to X profiles. **🎲 Shuffle** searches random, non-overlapping 7-day periods in an inactive background tab, weighted toward older dates. If a period has no visible posts, it tries another period, then opens X's Latest search for the selected post's day. The matching post is brought into view, and the button stays on the search page so you can try another post.

## Install

1. Download the latest `xshuffle-<version>.zip` from the Releases page and extract it.
2. Open `chrome://extensions` (Chrome, Edge, Brave) or `vivaldi://extensions` (Vivaldi).
3. Enable **Developer mode**, choose **Load unpacked**, and select the extracted `xshuffle-<version>` folder.
4. Visit an `x.com/username` profile and click **Shuffle**.

To build the package yourself from a clone, run `./scripts/package.sh`. It stages
only the files the browser loads, and refuses to produce a package that is missing
an asset the manifest or popup references.


Xshuffle uses no X API, backend, analytics, telemetry, or post collection. It stores the show/hide preference locally and temporary search state in browser-session storage so searches can finish if the background service worker restarts. Random windows sample account history without requesting the full history in one search; X may limit visible results, so this is not a uniform sample of every post. It tries up to 30 windows before reporting no result. X may change its profile markup, in which case the centralized selectors in `content.js` may need updating. The popup follows the active X page's light, dim, or dark theme and falls back to the system theme on other pages.
