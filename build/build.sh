#!/usr/bin/env bash
# Builds the packaged desktop app for the CURRENT operating system
# (macOS or Linux — see build.ps1 for Windows) into dist/AUGA-Builder/,
# then archives it as dist/AUGA-Builder-<os>-<arch>.tar.gz.
#
# Requires: uv, node/npm, and a Python venv with backend/requirements.txt +
# build/requirements-build.txt installed (this script creates one at
# build/.build-venv if it doesn't exist yet, so it never touches the
# project's own dev .venv).
set -euo pipefail

APP_NAME="AUGA-Builder"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_NAME="$(uname -m)"
case "$OS_NAME" in
  darwin) PLATFORM_TAG="macos" ;;
  linux) PLATFORM_TAG="linux" ;;
  *) PLATFORM_TAG="$OS_NAME" ;;
esac

echo "==> Building $APP_NAME for $PLATFORM_TAG ($ARCH_NAME)"

echo "==> [1/5] Building frontend"
(cd frontend && npm ci && npm run build)

echo "==> [2/5] Setting up the build toolchain (PyInstaller)"
if [ ! -d build/.build-venv ]; then
  uv venv build/.build-venv --python 3.12
fi
BUILD_PY="build/.build-venv/bin/python"
uv pip install --python "$BUILD_PY" -r backend/requirements.txt -r build/requirements-build.txt

echo "==> [3/5] Building a portable Python runtime for running scripts"
RUNTIME_TMP="build/.runtime-tmp"
rm -rf "$RUNTIME_TMP"
uv python install 3.12 --install-dir "$RUNTIME_TMP"
RUNTIME_SRC="$(find "$RUNTIME_TMP" -maxdepth 1 -type d -name 'cpython-*' | head -n1)"
if [ -z "$RUNTIME_SRC" ]; then
  echo "error: could not find the installed standalone Python build" >&2
  exit 1
fi
uv pip install --python "$RUNTIME_SRC/bin/python3" --break-system-packages -r scripts_requirements.txt

echo "==> [4/5] Running PyInstaller"
rm -rf "dist/$APP_NAME" build/pyinstaller-work
"$BUILD_PY" -m PyInstaller "build/$APP_NAME.spec" --noconfirm --distpath dist --workpath build/pyinstaller-work

echo "==> [5/5] Assembling final app bundle"
APP_DIR="dist/$APP_NAME"
mkdir -p "$APP_DIR/python-runtime"
# Flatten the runtime (drop the versioned cpython-3.x.y-... folder name) so
# appdirs.py can find it at a fixed, predictable path.
cp -R "$RUNTIME_SRC"/. "$APP_DIR/python-runtime/"
chmod +x "$APP_DIR/$APP_NAME" "$APP_DIR/python-runtime/bin/"* 2>/dev/null || true

ARCHIVE="dist/${APP_NAME}-${PLATFORM_TAG}-${ARCH_NAME}.tar.gz"
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C dist "$APP_NAME"

echo ""
echo "Done."
echo "  App folder: $APP_DIR/  (run ./$APP_NAME inside it)"
echo "  Archive:    $ARCHIVE"
du -sh "$ARCHIVE" 2>/dev/null || true
