# PyInstaller spec for the packaged desktop build.
#
# Run from the project root:
#   pyinstaller build/AUGA-Builder.spec --noconfirm
#
# Produces an onedir build at dist/AUGA-Builder/ — a folder containing the
# launcher executable plus everything it needs. Onedir (not onefile) is
# deliberate: the launcher re-runs a real Python interpreter to execute
# scripts (see backend/appdirs.py + process_manager.py), and onedir starts
# instantly on every run, whereas a onefile build would re-extract its whole
# bundle to a temp directory on every single launch.
#
# build/build.sh assembles the rest (bundles a portable Python runtime for
# running scripts, zips the result) around this spec's output.

import os

SPEC_DIR = os.path.abspath(SPECPATH)
PROJECT_ROOT = os.path.dirname(SPEC_DIR)
BACKEND_DIR = os.path.join(PROJECT_ROOT, "backend")
FRONTEND_DIST_SRC = os.path.join(PROJECT_ROOT, "frontend", "dist")

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

a = Analysis(
    [os.path.join(BACKEND_DIR, "launcher.py")],
    pathex=[BACKEND_DIR],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AUGA-Builder",
    debug=False,
    strip=False,
    upx=False,
    console=False,
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
    name="AUGA-Builder",
)
