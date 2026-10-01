# Xshuffle

Xshuffle adds a small **🎲 Shuffle** button to X profiles. Click it and it takes
you to a random post from that account's history — weighted toward the back
catalogue, so you land in 2011 rather than this morning.

The matching post is scrolled into view, and the button stays available so you
can shuffle again.

The button also appears on `from:` search results, so you can shuffle straight
from a search you typed yourself. That needs a record of the account's join
date and post count, which only the profile page shows — so visit a profile
once and its search results become shuffleable from then on.

## Install

1. Download `xshuffle-<version>-src.zip` from the Releases page and extract it.
2. Open your browser's extensions page:
   - Chrome, Edge, Brave, Opera, Vivaldi: `chrome://extensions`
   - Vivaldi also accepts `vivaldi://extensions`
3. Turn on **Developer mode** (top right), then **Load unpacked** and select the
   extracted `xshuffle-<version>` folder.
4. Visit an `x.com/username` profile and click **Shuffle**.

Nothing else is needed — no account, no API key, no build step.

To update, download the newer zip and repeat step 3, or click the reload arrow
on the extension card.

## Options

Open the popup from the toolbar:

| Option | What it does |
| --- | --- |
| **Show Shuffle UI** | Hide the button on profiles without uninstalling |
| **Hide replies** | Adds `filter:replies` to the search |
| **Photos and video only** | Adds `filter:media` to the search |
| **Open one post** | Lands on a single post instead of a day of results |
| **Search window** | How many days each search covers |

### About the search window

X returns roughly a page of results per search no matter how wide a date range
you ask for, so a wider window is a genuine trade-off:

- **Narrow (1–7 days)** — precise, but you shuffle many times before hitting
  an account's posting rhythm.
- **Wide (30–90 days)** — one search covers much more, so you find a post
  faster, but the "random day" is less exact.
- **Auto** — the default. Xshuffle sizes the window from the account's own age
  and post count.

Heavily used accounts can hit X's search rate limits. When that happens X
shows an error page instead of results, and Xshuffle reads it, pauses itself,
and tells you — rather than searching again and making the limit worse.

## How it picks a post

For a short-lived account, one wide search returns the whole history, and
Xshuffle picks from those posts weighted by age — an older post is genuinely
more likely, so a shuffle feels like time travel.

For a long-lived account, one search only returns a page of recent results, so
age-weighting that page would just keep landing on today. Xshuffle detects that
and searches a random *older* window instead, which reaches the real back
catalogue.

## Privacy

Xshuffle has no backend, no analytics, no telemetry, and no X API. It makes no
network requests other than the X searches you trigger, which happen in your
own logged-in browser session.

Stored locally only:

- your show/hide and option preferences
- a pause expiry and its reason, set only when X rate-limits the account
- the join date and post count of profiles you have visited, keyed by
  username, so a `from:` search you typed yourself can be shuffled. Entries
  are per-account — shuffling a second person's history reads their entry,
  never the first one's — and an entry is dropped as soon as a search for
  that account comes back empty, which is the signature of a stale post
  count. Capped at the 200 most recent.

There is no account, no donation prompt, and no tracking of any kind.

## Building from source

```sh
./test/run.sh        # run the test suite
./scripts/package.sh # build the packages
./scripts/release.sh # test, package, privacy-check, tag
```

`scripts/package.sh` stages only the files the browser loads and refuses to
build a package missing an asset the manifest or popup references. It also
produces a flat archive for store uploads, though this project publishes on
GitHub Releases rather than a store.

### Privacy gate

Every package and release runs `scripts/privacy-gate.sh` first, which scans
files, archive contents, archive member names, commit history, and remotes for
identity terms. It **fails closed**: if the local pattern file is missing or
malformed, the build stops rather than shipping unchecked. Copy
`.anon-identities.example` to `.anon-identities` and add your own terms.

## Limitations

- X limits how many results a single search returns, so Xshuffle cannot
  guarantee a uniform sample of every post. It samples the history.
- Accounts with very sparse posting can still come up empty.
- X may change its profile markup; the selectors are centralized in
  `content.js` when that happens.
- Shuffle is rate-limited by X, not by Xshuffle. Xshuffle stops as soon as X
  says so, but it cannot shorten the wait — that one is on X's side.

## License

MIT — see [LICENSE](LICENSE).
