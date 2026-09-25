#!/usr/bin/env bash
# Builds the packaged desktop app for the CURRENT operating system
# (macOS or Linux — see build.ps1 for Windows): dist/AUGA-Builder.app on
# macOS, dist/AUGA-Builder/ on Linux, then archives it as
# dist/AUGA-Builder-<os>-<arch>.tar.gz.
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
# Normalized arch names keep the release file names stable, so the README's
# "latest release" download links never go stale.
case "$(uname -m)" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) ARCH_NAME="$(uname -m)" ;;
esac
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
  # Must be the same Python minor version as the runtime below (3.12): the
  # app's server borrows pandas/pyarrow from that runtime.
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
# Standard-library modules the Data Editor's pandas/pyarrow need; the app's
# server bundles these (it borrows pandas/pyarrow themselves from this runtime).
"$RUNTIME_SRC/bin/python3" build/stdlib_for_editor.py > build/.editor-stdlib.txt

echo "==> [4/5] Running PyInstaller"
# Version shown in the macOS app's Info: CI passes it from the git tag; a
# local build falls back to the latest tag in this repo.
if [ -z "${AUGA_VERSION:-}" ]; then
  AUGA_VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)"
  AUGA_VERSION="${AUGA_VERSION#v}"
fi
export AUGA_VERSION
rm -rf "dist/$APP_NAME" "dist/$APP_NAME.app" build/pyinstaller-work
"$BUILD_PY" -m PyInstaller "build/$APP_NAME.spec" --noconfirm --distpath dist --workpath build/pyinstaller-work

echo "==> [5/5] Assembling final app bundle (version $AUGA_VERSION)"
ARCHIVE="dist/${APP_NAME}-${PLATFORM_TAG}-${ARCH_NAME}.tar.gz"
rm -f "$ARCHIVE"

if [ "$PLATFORM_TAG" = "macos" ]; then
  # macOS: a double-clickable AUGA-Builder.app with the silver-bar icon.
  # The portable Python goes *inside* the app, so the app still works when
  # moved to /Applications (or run from macOS's read-only quarantine copy).
  APP_BUNDLE="dist/$APP_NAME.app"
  RUNTIME_DEST="$APP_BUNDLE/Contents/Resources/python-runtime"
  mkdir -p "$RUNTIME_DEST"
  cp -R "$RUNTIME_SRC"/. "$RUNTIME_DEST/"
  # Adding files changed the bundle, so re-seal it with an ad-hoc signature;
  # otherwise macOS reports the downloaded app as "damaged".
  codesign --force --deep --sign - "$APP_BUNDLE"
  codesign --verify --deep --strict "$APP_BUNDLE"
  tar -czf "$ARCHIVE" -C dist "$APP_NAME.app"
  RESULT="$APP_BUNDLE  (double-click it)"
else
  # Linux: a folder with the executable, the icon, and a helper that adds
  # AUGA-Builder (with its icon) to the desktop's app menu.
  APP_DIR="dist/$APP_NAME"
  mkdir -p "$APP_DIR/python-runtime"
  # Flatten the runtime (drop the versioned cpython-3.x.y-... folder name) so
  # appdirs.py can find it at a fixed, predictable path.
  cp -R "$RUNTIME_SRC"/. "$APP_DIR/python-runtime/"
  cp assets/icon.png "$APP_DIR/$APP_NAME.png"
  cat > "$APP_DIR/add-to-app-menu.sh" <<'MENU'
#!/usr/bin/env bash
# Adds AUGA-Builder, with its icon, to your desktop's app menu.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/auga-builder.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AUGA-Builder
Comment=Run your Python scripts from a clean dashboard
Exec="$DIR/AUGA-Builder"
Icon=$DIR/AUGA-Builder.png
Terminal=false
Categories=Development;Utility;
EOF
chmod +x "$HOME/.local/share/applications/auga-builder.desktop"
echo "Added. Look for AUGA-Builder in your app menu."
MENU
  chmod +x "$APP_DIR/$APP_NAME" "$APP_DIR/add-to-app-menu.sh" "$APP_DIR/python-runtime/bin/"* 2>/dev/null || true
  tar -czf "$ARCHIVE" -C dist "$APP_NAME"
  RESULT="$APP_DIR/  (run ./$APP_NAME inside it)"
fi

echo ""
echo "Done."
echo "  App:     $RESULT"
echo "  Archive: $ARCHIVE"
du -sh "$ARCHIVE" 2>/dev/null || true
