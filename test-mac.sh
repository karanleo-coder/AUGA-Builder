#!/usr/bin/env bash
# Build the macOS app and test it on this Mac, before publishing a release.
#
#   ./test-mac.sh               build, run the automatic checks, then open the app
#   ./test-mac.sh --no-build    skip the build and test the last one (dist/)
#   ./test-mac.sh --no-open     only run the checks, don't open the app afterwards
#   ./test-mac.sh --fresh       open it as a brand-new user would see it (a temporary
#                               home folder, so your real ~/AUGA-Builder isn't touched)
#   ./test-mac.sh --all-modes   also test the Chrome app-window mode Linux uses
#
# The automatic checks are the same ones GitHub runs on every release
# (build/smoke_test.py): the app starts in its own window, runs a script with
# its bundled Python, adds scripts from a .zip and a folder, refuses requests
# from other websites, reopens instead of starting twice, and quits cleanly.
# They use a temporary home folder, so your own scripts are never touched.
set -euo pipefail

cd "$(dirname "$0")"
APP_NAME="AUGA-Builder"
BUILD=1 OPEN=1 FRESH="" ALL_MODES=""
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD="" ;;
    --no-open) OPEN="" ;;
    --fresh) FRESH=1 ;;
    --all-modes) ALL_MODES=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see ./test-mac.sh --help)" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this script builds and tests the macOS app, so run it on a Mac."

# A copy of the app that's already open would answer instead of the one under test.
if curl -sf -m 2 http://127.0.0.1:8756/api/health 2>/dev/null | grep -q "$APP_NAME"; then
  read -rp "AUGA-Builder is already running. Quit it so it can be tested? (running scripts stop) [y/N] " yn
  [[ "$yn" =~ ^[Yy] ]] || fail "quit AUGA-Builder first, then run this again."
  curl -s -X POST http://127.0.0.1:8756/api/shutdown >/dev/null || true
  for _ in $(seq 1 20); do curl -sf -m 1 http://127.0.0.1:8756/api/health >/dev/null || break; sleep 0.5; done
fi

ARCHIVE="dist/$APP_NAME-macos-arm64.tar.gz"
if [ -n "$BUILD" ]; then
  step "Building the macOS app (a few minutes the first time)"
  LOG="dist/build-mac.log"
  mkdir -p dist
  if ! ./build/build.sh > "$LOG" 2>&1; then
    tail -30 "$LOG"
    fail "the build failed. Full log: $LOG"
  fi
  tail -3 "$LOG"
fi
[ -f "$ARCHIVE" ] || fail "no build found at $ARCHIVE. Run without --no-build."

step "Checking the app's signature (a broken one makes macOS say the app is 'damaged')"
codesign --verify --deep --strict "dist/$APP_NAME.app" && echo "signature OK"

# Test exactly what people download: unpack the archive somewhere fresh.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/auga-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$ARCHIVE" -C "$WORK"
APP="$WORK/$APP_NAME.app"
BIN="$APP/Contents/MacOS/$APP_NAME"
echo "unpacked to $WORK"

if command -v uv >/dev/null; then
  PY=(uv run --no-project --python 3.12)
else
  PY=(python3)
fi

step "Automatic checks: native window (a window will open and close by itself)"
"${PY[@]}" build/smoke_test.py "$BIN" --expect-mode window || fail "the checks above failed."

if [ -n "$ALL_MODES" ]; then
  step "Automatic checks: Chrome app-window mode (what Linux uses)"
  AUGA_WINDOW=app "${PY[@]}" build/smoke_test.py "$BIN" --expect-mode app-window \
    || fail "the app-window checks failed (is Google Chrome installed?)."
fi

printf '\n\033[32mAll checks passed.\033[0m\n'

if [ -n "$OPEN" ]; then
  if [ -n "$FRESH" ]; then
    HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/auga-fresh-home.XXXXXX")"
    step "Opening the app as a brand-new user (scripts in $HOME_DIR/AUGA-Builder)"
    # Keep the unpacked copy: the trap would delete it while the app is open.
    trap - EXIT
    open --env HOME="$HOME_DIR" "$APP"
  else
    step "Opening the app (your scripts: ~/AUGA-Builder/scripts)"
    open "dist/$APP_NAME.app"
  fi
  echo "Try it out: add a folder or .zip in Settings, run a script, close the window to quit."
fi
