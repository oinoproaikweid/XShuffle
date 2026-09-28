#!/usr/bin/env bash
# Cut a release. The privacy gate is MANDATORY and runs before anything is
# published: if it fails, this script exits and no release is created.
#
#   ./scripts/release.sh v1.1.2 "Release notes here"
#
# Steps: verify tests -> build package -> privacy-gate the package AND the
# git history -> push tag -> create the GitHub release. The gate is checked
# twice, before and after the tag, so nothing can slip in via the tag itself.
set -euo pipefail

cd "$(dirname "$0")/.."
TAG="${1:-}"
NOTES="${2:-}"

if [ -z "$TAG" ]; then
  echo "usage: $0 <tag> [notes]" >&2
  exit 2
fi
case "$TAG" in
  v*) ;;
  *) echo "tag should start with 'v' (e.g. v1.1.2), got: $TAG" >&2; exit 2 ;;
esac

VERSION="$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")"
if [ "v$VERSION" != "$TAG" ]; then
  echo "tag $TAG does not match manifest version v$VERSION." >&2
  echo "Bump manifest.json first, or use the right tag." >&2
  exit 2
fi

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1/5  tests"
./test/run.sh

step "2/5  build package"
./scripts/package.sh

step "3/5  privacy gate (mandatory)"
./scripts/privacy-gate.sh \
  --files "dist/xshuffle-$VERSION" \
  --archive "dist/xshuffle-$VERSION.zip" \
  --history HEAD

step "4/5  tag and push"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

step "5/5  verify the pushed tag, then release"
# Re-check the tag that actually left the machine, not just the local state.
./scripts/privacy-gate.sh --history "$TAG" --files "dist/xshuffle-$VERSION"

gh release create "$TAG" "dist/xshuffle-$VERSION.zip" \
  --title "$TAG" \
  --notes "${NOTES:-Release $TAG. See the README for install steps.}"

echo
echo "Release $TAG created: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$TAG"
