#!/usr/bin/env bash
# Privacy gate. Refuses to pass while any local identity term appears in
# something that is about to be published.
#
#   ./scripts/privacy-gate.sh --files <path>...   scan file contents
#   ./scripts/privacy-gate.sh --archive <zip>      scan inside an archive
#   ./scripts/privacy-gate.sh --history <ref>      scan commit metadata
#   ./scripts/privacy-gate.sh --files A --history HEAD   combine scopes
#
# At least one scope is required. Scanning nothing is not a pass.
#
# Every path given must exist. A missing --files or --archive path is a hard
# error, not a skip: these paths are built from a version string, so a
# mismatch would scan nothing and still report PASSED.
#
# Matching is CASE-INSENSITIVE. A name cased one way in a term file and
# another way in the text - a lowercase handle vs its capitalised form in a
# commit subject, or in a README credit line - is the same identity, and a
# case-sensitive gate reports those files clean. Always write terms in
# whatever case is convenient; it does not matter.
#
# Exits non-zero on any hit, so it can gate a release. The identity terms
# come from the LOCAL, never-committed .anon-identities file. Without that
# file this refuses to pass: an empty term list would silently allow
# everything, which is the failure mode that matters here.
set -euo pipefail

cd "$(dirname "$0")/.."
TERMS_FILE=".anon-identities"
SCAN_FILES=()
SCAN_ARCHIVES=()
SCAN_HISTORY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --files)    shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do SCAN_FILES+=("$1"); shift; done ;;
    --archive)  shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do SCAN_ARCHIVES+=("$1"); shift; done ;;
    # The ref has to be consumed as well as read, or it survives the shift and
    # falls through to the unknown-argument case below. --history therefore
    # failed for every value, which meant the history scope silently never ran
    # - including in release.sh, where it is supposed to be mandatory.
    --history)  shift; SCAN_HISTORY="${1:-HEAD}"; if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then shift; fi ;;
    -h|--help)  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$TERMS_FILE" ]; then
  cat >&2 <<EOF
BLOCKED: $TERMS_FILE is missing.

The privacy gate has no identity terms to search for, so it cannot prove
anything is clean. Create the file (one regex per line) before releasing.
It is gitignored and must never be committed.
EOF
  exit 3
fi

# Parse the terms file into a clean pattern file. Comments and blanks are
# dropped, and the result is validated: a malformed regex must fail the
# gate loudly rather than silently match nothing.
PATTERNS="$(mktemp)"

while IFS= read -r line || [ -n "$line" ]; do
  # Strip a trailing comment, but only when the line does not start with '#'
  # and the '#' is not escaped. Terms are regexes, so a literal '#' is rare.
  case "$line" in
    '#'*) continue ;;
  esac
  line="${line%%#*}"
  line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$line" ] && printf '%s\n' "$line" >> "$PATTERNS"
done < "$TERMS_FILE"

if [ ! -s "$PATTERNS" ]; then
  echo "BLOCKED: $TERMS_FILE contains no terms. Refusing to pass on an empty list." >&2
  exit 3
fi

# Validate every pattern compiles. A bad regex here would otherwise make the
# whole gate silently useless, which is the one outcome that must never happen.
if ! grep -qiEI -f "$PATTERNS" /dev/null 2>/tmp/anon-gate-greperr; then
  if [ -s /tmp/anon-gate-greperr ]; then
    echo "BLOCKED: malformed regex in $TERMS_FILE:" >&2
    cat /tmp/anon-gate-greperr >&2
    rm -f /tmp/anon-gate-greperr
    exit 3
  fi
fi
rm -f /tmp/anon-gate-greperr
trap 'rm -f "$PATTERNS"' EXIT

FAILED=0
note_hit() {
  FAILED=1
  printf '  \033[31mHIT\033[0m  %s\n' "$1"
  printf '        %s\n' "$2"
}

# At least one scope is mandatory. Every scan loop below is driven purely by
# these three variables, so an invocation with none of them set scanned
# NOTHING and still fell through to the PASSED branch and exit 0 - a green
# result for zero work. That is the one outcome this gate exists to prevent:
# a term provably present in a tracked file passed the bare invocation.
if [ "${#SCAN_FILES[@]}" -eq 0 ] && [ "${#SCAN_ARCHIVES[@]}" -eq 0 ] && [ -z "$SCAN_HISTORY" ]; then
  cat >&2 <<EOF
BLOCKED: no scan scope given.

Nothing was selected to scan, so there is nothing this run could have found.
Pass at least one of:

  --files <path>...     scan file contents
  --archive <zip>       scan inside an archive
  --history <ref>       scan commit metadata

Refusing to report PASSED for a run that inspected no files.
EOF
  exit 3
fi

echo "Privacy gate: $(wc -l < "$PATTERNS" | tr -d ' ') identity term(s) loaded from $TERMS_FILE"

# --- 1. Plain files -------------------------------------------------------
for f in "${SCAN_FILES[@]+"${SCAN_FILES[@]}"}"; do
  # A path that does not exist is a hard error, not a skip. These paths are
  # built from a version string (package.sh derives them from manifest.json),
  # so a version mismatch produces a path that will never exist - and the run
  # would scan nothing while still reporting PASSED. That is the same
  # "green for zero work" failure as passing no scope at all.
  if [ ! -e "$f" ]; then
    cat >&2 <<EOF
BLOCKED: $f does not exist.

Every path given to --files must exist. An unreadable path means the scope
was wrong - a typo, or a version string that does not match what was built -
and nothing was scanned. Fix the path or build the artefact first.
EOF
    exit 3
  fi
  echo "Scanning: ${f/#$PWD\//}"
  if [ -d "$f" ]; then
    # -r recurses, -l lists only matching file names
    while IFS= read -r path; do
      note_hit "identity term in $path" "$(grep -niEI -f "$PATTERNS" "$path" | head -3 | sed 's/^/        /')"
    done < <(grep -rliEI -f "$PATTERNS" "$f" 2>/dev/null || true)
  else
    if grep -qiEI -f "$PATTERNS" "$f"; then
      note_hit "identity term in $f" "$(grep -niEI -f "$PATTERNS" "$f" | head -3 | sed 's/^/        /')"
    fi
  fi
done

# --- 2. Archives ----------------------------------------------------------
for a in "${SCAN_ARCHIVES[@]+"${SCAN_ARCHIVES[@]}"}"; do
  # Same reasoning as --files: a missing archive is a wrong scope, not a skip.
  if [ ! -f "$a" ]; then
    cat >&2 <<EOF
BLOCKED: $a does not exist or is not a regular file.

Every path given to --archive must be an existing archive. Without it the
release artefact was never scanned, which is the exact thing this gate runs
to rule out.
EOF
    exit 3
  fi
  echo "Scanning archive: $a"
  tmp="$(mktemp -d)"
  if unzip -qq "$a" -d "$tmp" 2>/dev/null; then
    while IFS= read -r path; do
      note_hit "identity term inside $a -> ${path#$tmp/}" "$(grep -niEI -f "$PATTERNS" "$path" | head -3 | sed 's/^/        /')"
    done < <(grep -rliEI -f "$PATTERNS" "$tmp" 2>/dev/null || true)
    # Also check archive member names.
    if unzip -Z1 "$a" | grep -qiEI -f "$PATTERNS"; then
      note_hit "identity term in archive member name" "$(unzip -Z1 "$a" | grep -iEI -f "$PATTERNS" | head -3)"
    fi
  else
    echo "  \033[31mFAIL\033[0m  could not unpack $a"
    FAILED=1
  fi
  rm -rf "$tmp"
done

# --- 3. Git history metadata ---------------------------------------------
if [ -n "$SCAN_HISTORY" ]; then
  echo "Scanning git history metadata: $SCAN_HISTORY"
  LOG="$(git log --all --format='%H%n%an <%ae>%n%cn <%ce>%n%s%n%b' "$SCAN_HISTORY" 2>/dev/null || true)"
  if printf '%s' "$LOG" | grep -qiEI -f "$PATTERNS"; then
    note_hit "identity term in commit metadata" "$(printf '%s' "$LOG" | grep -niEI -f "$PATTERNS" | head -3)"
  fi
  # Pushed remotes leak the account name too.
  REMOTES="$(git remote -v 2>/dev/null || true)"
  if printf '%s' "$REMOTES" | grep -qiEI -f "$PATTERNS"; then
    note_hit "identity term in git remote URL" "$(printf '%s' "$REMOTES" | grep -iEI -f "$PATTERNS")"
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  printf '\033[31mBLOCKED\033[0m - identity terms found. Do not publish.\n'
  exit 1
fi
printf '\033[32mPASSED\033[0m - no identity terms found in the scanned scope.\n'
