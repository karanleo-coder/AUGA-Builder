"""Where the app's files live, for both a normal dev run and a packaged
desktop build (PyInstaller).

Dev mode: APP_ROOT is the project's repo root (parent of backend/) — the
same layout this project has always had, with scripts sitting in their own
folders there and a `.venv` next to them.

Packaged mode (``FROZEN``): APP_ROOT is the folder the executable itself was
launched from. A person who unzipped and ran the packaged app gets a
"scripts" folder next to the executable to drop their own .py files into
(seeded with the bundled demo scripts on first run), a "data" folder next to
it for persistent state, and a "python-runtime" folder — a real, portable
Python interpreter (built with `python-build-standalone` via `uv python
install`) used to actually run scripts, completely independent of whatever
Python (if any) is installed on the machine.
"""
from __future__ import annotations

import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
WINDOWS = sys.platform == "win32"

if FROZEN:
    # PyInstaller sets sys.executable to the packaged binary's own path.
    APP_ROOT = Path(sys.executable).resolve().parent
    # Read-only bundle contents (frontend build, seed scripts) live here —
    # PyInstaller sets this for both --onefile and --onedir builds.
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_ROOT))
    SCRIPTS_DIR = APP_ROOT / "scripts"
    PYTHON_RUNTIME_DIR = APP_ROOT / "python-runtime"
else:
    APP_ROOT = Path(__file__).resolve().parent.parent
    BUNDLE_DIR = APP_ROOT
    SCRIPTS_DIR = APP_ROOT  # scan the whole repo, as in normal dev use
    PYTHON_RUNTIME_DIR = APP_ROOT / ".venv"

DATA_DIR = APP_ROOT / "data"
# In dev mode this is Vite's own build output; in a packaged build it's the
# bundle folder PyInstaller copies that same output into (see build/*.spec).
FRONTEND_DIST = (BUNDLE_DIR / "frontend_dist") if FROZEN else (APP_ROOT / "frontend" / "dist")
SEED_SCRIPTS_DIR = BUNDLE_DIR / "seed_scripts"


def bundled_python() -> str | None:
    """Path to the interpreter scripts should be run with, if a bundled
    portable runtime is present (packaged mode) or the project .venv exists
    (dev mode). None means: fall back to whatever `sys.executable` is."""
    if WINDOWS:
        candidate = PYTHON_RUNTIME_DIR / "python.exe"
        if not candidate.exists():
            # uv's standalone installs nest one more folder, e.g.
            # python-runtime/cpython-3.12.x-windows-.../python.exe
            for sub in PYTHON_RUNTIME_DIR.glob("cpython-*"):
                nested = sub / "python.exe"
                if nested.exists():
                    return str(nested)
    else:
        candidate = PYTHON_RUNTIME_DIR / "bin" / "python3"
        if not candidate.exists():
            for sub in PYTHON_RUNTIME_DIR.glob("cpython-*"):
                nested = sub / "bin" / "python3"
                if nested.exists():
                    return str(nested)
    return str(candidate) if candidate.exists() else None
