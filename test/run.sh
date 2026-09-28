#!/usr/bin/env bash
# Run the full headless test suite. Requires node; jsdom is a dev-only
# dependency and is not needed to run the extension itself.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules/jsdom ]; then
  echo "Installing test dependencies..."
  npm install --no-save --no-audit --no-fund jsdom >/dev/null
fi

echo "== background (service worker) =="
node test/background.test.mjs
echo
echo "== content (DOM parsing) =="
node test/content.test.mjs
echo
echo "== adaptive window (posting-rate sizing) =="
node test/adaptive.test.mjs
echo
echo "== search options (filters, range, cooldown) =="
node test/options.test.mjs
echo
echo "== probe search (whole-history lookup) =="
node test/probe.test.mjs
