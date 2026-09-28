#!/usr/bin/env bash
# Build a loadable Xshuffle package: only the files the browser needs.
#
#   ./scripts/package.sh [output-dir]
#
# Produces <output-dir>/xshuffle-<version>/ containing manifest.json and the
# runtime sources, ready for "Load unpacked". Excludes tests, tooling and
# dependencies so the download stays a few tens of kilobytes.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")"
OUT="${1:-dist}"
STAGE="$OUT/xshuffle-$VERSION"

# Runtime files, taken from the manifest's own references where possible.
FILES=(
  manifest.json
  background.js
  content.js
  styles.css
  popup.html
  popup.js
  LICENSE
)

rm -rf "$STAGE"
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "missing required file: $f" >&2; exit 1; }
  cp "$f" "$STAGE/"
done

# Refuse to ship anything the browser would choke on, or any file that is
# neither manifest-referenced nor pulled in by the popup document.
python3 - "$STAGE" <<'PY'
import json, sys, os, re
stage = sys.argv[1]
m = json.load(open(os.path.join(stage, 'manifest.json')))

refs = [m['background']['service_worker'], m['action']['default_popup']]
for cs in m.get('content_scripts', []):
    refs += cs.get('js', []) + cs.get('css', [])

missing = [r for r in refs if not os.path.isfile(os.path.join(stage, r))]
if missing:
    sys.exit(f"package incomplete, missing: {missing}")

# Assets referenced from the popup HTML (stylesheets and <script src>) are
# loaded by the browser but never named in the manifest, so follow them too.
expected = {os.path.basename(r) for r in refs} | {'manifest.json', 'LICENSE'}
for doc in (m['action']['default_popup'],):
    html = open(os.path.join(stage, doc)).read()
    for asset in re.findall(r'(?:src|href)="([^"]+)"', html):
        if asset.startswith(('http:', 'https:', 'data:')):
            sys.exit(f"popup references an external asset: {asset}")
        if not os.path.isfile(os.path.join(stage, asset)):
            sys.exit(f"popup references a missing asset: {asset}")
        expected.add(os.path.basename(asset))

shipped = set(os.listdir(stage))
extra = shipped - expected
if extra:
    sys.exit(f"unexpected extra files in package: {sorted(extra)}")
absent = expected - shipped
if absent:
    sys.exit(f"expected files absent from package: {sorted(absent)}")
print(f"  manifest v{m['version']} verified, {len(refs)} manifest refs present")
print(f"  popup assets followed, {len(expected)} files total, none extraneous")
PY

# Two archives, because the two audiences want different shapes:
#
#   xshuffle-<v>.zip        flat, manifest.json at the root. This is what the
#                           Chrome Web Store, Edge Add-ons and the other
#                           stores require - an upload with a wrapping folder
#                           is rejected outright.
#   xshuffle-<v>-src.zip    same files under one top-level folder. This is
#                           what someone unpacking a GitHub release expects,
#                           and what Firefox's about:debugging accepts.
#
# The unpacked folder is also left on disk for "Load unpacked".
rm -f "$OUT/xshuffle-$VERSION.zip" "$OUT/xshuffle-$VERSION-src.zip"
# Resolve the archive paths before cd'ing, since the zip calls run inside the
# directory being archived and a relative path would no longer resolve.
STORE_ZIP="$(cd "$OUT" && pwd)/xshuffle-$VERSION.zip"
SRC_ZIP="$(cd "$OUT" && pwd)/xshuffle-$VERSION-src.zip"
( cd "$STAGE" && zip -qr "$STORE_ZIP" . -x '.*' )
( cd "$OUT" && zip -qr "$SRC_ZIP" "xshuffle-$VERSION" )

# Both archives must pass the privacy gate, and the flat one must really be
# flat: a store silently ignoring a nested manifest is a bad way to find out.
python3 - "$STORE_ZIP" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    names = [n for n in z.namelist() if not n.endswith('/')]
if 'manifest.json' not in names:
    sys.exit(f"store archive must have manifest.json at the root; got: {names}")
depth = {n.count('/') for n in names}
if len(depth) != 1:
    sys.exit(f"store archive must be flat; got nesting: {sorted(names)}")
print(f"  store archive is flat, manifest.json at root ({len(names)} files)")
PY

echo
echo "Built:"
ls -lh "$STORE_ZIP" | awk '{print "  store zip  ", $5, $9}'
ls -lh "$SRC_ZIP" | awk '{print "  source zip ", $5, $9}'
echo "  folder     " "$STAGE"
du -sh "$STAGE" | awk '{print "  size       ", $1, "unpacked"}'

# Privacy gate: every package is checked, not just releases. If the local
# terms file is absent the gate fails closed, so a missing config blocks the
# build rather than letting anything ship unchecked.
echo
echo "Privacy gate (package):"
if [ -x scripts/privacy-gate.sh ]; then
  ./scripts/privacy-gate.sh --files "$STAGE" --archive "$STORE_ZIP" --archive "$SRC_ZIP"
else
  echo "  scripts/privacy-gate.sh not found or not executable." >&2
  echo "  cp .anon-identities.example .anon-identities and chmod +x the script." >&2
  exit 1
fi
