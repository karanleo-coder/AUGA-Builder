# PyInstaller spec for the packaged desktop build.
#
# Run from the project root:
#   pyinstaller build/AUGA-Builder.spec --noconfirm
#
# Produces an onedir build at dist/AUGA-Builder/ — a folder containing the
# launcher executable plus everything it needs — and on macOS additionally
# wraps it as dist/AUGA-Builder.app. Onedir (not onefile) is
# deliberate: the launcher re-runs a real Python interpreter to execute
# scripts (see backend/appdirs.py + process_manager.py), and onedir starts
# instantly on every run, whereas a onefile build would re-extract its whole
# bundle to a temp directory on every single launch.
#
# build/build.sh assembles the rest (bundles a portable Python runtime for
# running scripts, zips the result) around this spec's output.

import os
import sys

SPEC_DIR = os.path.abspath(SPECPATH)
PROJECT_ROOT = os.path.dirname(SPEC_DIR)
BACKEND_DIR = os.path.join(PROJECT_ROOT, "backend")
FRONTEND_DIST_SRC = os.path.join(PROJECT_ROOT, "frontend", "dist")
ASSETS_DIR = os.path.join(PROJECT_ROOT, "assets")

APP_NAME = "AUGA-Builder"
# Set by CI from the git tag (v1.2.3 -> 1.2.3); shown in the macOS app's Info.
APP_VERSION = os.environ.get("AUGA_VERSION", "0.0.0")

# Silver-bar app icon: embedded in the .exe on Windows, the .app on macOS.
# (Linux executables have no embedded icon; build.sh ships icon.png plus an
# "add to app menu" helper instead.)
if sys.platform == "win32":
    ICON = os.path.join(ASSETS_DIR, "icon.ico")
elif sys.platform == "darwin":
    ICON = os.path.join(ASSETS_DIR, "icon.icns")
else:
    ICON = None

SEED_SCRIPT_FOLDERS = [
    "github_data_downloader",
    "github_data_hunter",
    "pretaring datasets maker",
]

hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.utils",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "websockets",
    "websockets.legacy",
    "websockets.legacy.server",
    "h11",
    "pydantic",
    "pydantic_core",
]

# Native window backend (pywebview): only the one this OS uses.
UNUSED_WEBVIEW = ["webview.platforms.gtk", "webview.platforms.qt",
                  "webview.platforms.cef", "webview.platforms.android",
                  "webview.platforms.mshtml"]
if sys.platform == "win32":
    hiddenimports += ["webview", "webview.platforms.winforms",
                      "webview.platforms.edgechromium", "clr"]
    excludes = UNUSED_WEBVIEW + ["webview.platforms.cocoa"]
elif sys.platform == "darwin":
    hiddenimports += ["webview", "webview.platforms.cocoa"]
    excludes = UNUSED_WEBVIEW + ["webview.platforms.winforms",
                                 "webview.platforms.edgechromium"]
else:
    excludes = ["webview"]  # Linux uses a Chromium --app window instead

a = Analysis(
    [os.path.join(BACKEND_DIR, "launcher.py")],
    pathex=[BACKEND_DIR],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=excludes,
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    strip=False,
    upx=False,
    console=False,
    icon=ICON,
)

trees = [Tree(FRONTEND_DIST_SRC, prefix="frontend_dist")]
for folder in SEED_SCRIPT_FOLDERS:
    src = os.path.join(PROJECT_ROOT, folder)
    if os.path.isdir(src):
        trees.append(Tree(src, prefix=os.path.join("seed_scripts", folder)))

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    *trees,
    strip=False,
    upx=False,
    name=APP_NAME,
)

if sys.platform == "darwin":
    # A real macOS app bundle: its own window, Dock icon and menu bar, and
    # the silver-bar icon in Finder/Launchpad.
    app = BUNDLE(
        coll,
        name=f"{APP_NAME}.app",
        icon=ICON,
        bundle_identifier="com.karanleo.auga-builder",
        version=APP_VERSION,
        info_plist={
            "CFBundleName": APP_NAME,
            "CFBundleDisplayName": APP_NAME,
            "CFBundleShortVersionString": APP_VERSION,
            "CFBundleVersion": APP_VERSION,
            "NSHighResolutionCapable": True,
        },
    )
