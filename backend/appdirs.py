"""Where the app's files live, for both a normal dev run and a packaged
desktop build (PyInstaller).

Dev mode: APP_ROOT is the project's repo root (parent of backend/) — the
same layout this project has always had, with scripts sitting in their own
folders there and a `.venv` next to them.

Packaged mode (``FROZEN``): the user's things live in ``~/AUGA-Builder``
(``C:\\Users\\<you>\\AUGA-Builder`` on Windows) on every OS: a "scripts"
folder to drop .py files into (seeded with the bundled demo scripts on first
run) and a "data" folder for the app's state and log. Nothing of the user's
lives inside the app, so updating is just replacing the app; and on macOS a
freshly downloaded app may run from a read-only temporary location ("App
Translocation"), so writing next to it wouldn't work anyway.

The app brings a real, portable Python interpreter ("python-runtime", built
with `python-build-standalone` via `uv python install`) that actually runs
scripts, independent of whatever Python (if any) is installed. It sits next
to the executable on Windows/Linux, and inside the app on macOS
(AUGA-Builder.app/Contents/Resources/python-runtime).
"""
from __future__ import annotations

import sys
from pathlib import Path

APP_NAME = "AUGA-Builder"
FROZEN = bool(getattr(sys, "frozen", False))
WINDOWS = sys.platform == "win32"

_exe = Path(sys.executable).resolve()
# .../AUGA-Builder.app/Contents/MacOS/AUGA-Builder
MAC_APP_BUNDLE = (
    FROZEN
    and sys.platform == "darwin"
    and _exe.parent.name == "MacOS"
    and _exe.parent.parent.name == "Contents"
)

if FROZEN:
    # Read-only bundle contents (frontend build, seed scripts) live here —
    # PyInstaller sets this for every build type, including .app bundles.
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", _exe.parent))
    # Your scripts and the app's data live in ~/AUGA-Builder on every OS, so
    # updating = just replacing the app (nothing of yours is inside it).
    APP_ROOT = Path.home() / APP_NAME
    if MAC_APP_BUNDLE:
        PYTHON_RUNTIME_DIR = _exe.parent.parent / "Resources" / "python-runtime"
    else:
        PYTHON_RUNTIME_DIR = _exe.parent / "python-runtime"
    SCRIPTS_DIR = APP_ROOT / "scripts"
else:
    APP_ROOT = Path(__file__).resolve().parent.parent
    BUNDLE_DIR = APP_ROOT
    SCRIPTS_DIR = APP_ROOT  # scan the whole repo, as in normal dev use
    PYTHON_RUNTIME_DIR = APP_ROOT / ".venv"

DATA_DIR = APP_ROOT / "data"
# Extra Python packages the user installs for their scripts (Settings ->
# Install a package). Kept outside the app, so they survive updates and never
# touch the app's signed bundle; added to PYTHONPATH for every script run.
PACKAGES_DIR = (APP_ROOT / "packages") if FROZEN else (DATA_DIR / "packages")
# In dev mode this is Vite's own build output; in a packaged build it's the
# bundle folder PyInstaller copies that same output into (see build/*.spec).
FRONTEND_DIST = (BUNDLE_DIR / "frontend_dist") if FROZEN else (APP_ROOT / "frontend" / "dist")
SEED_SCRIPTS_DIR = BUNDLE_DIR / "seed_scripts"


def bundled_python() -> str | None:
    """Path to the interpreter scripts should be run with: the app's own
    portable runtime (packaged mode) or the project .venv (dev mode). None
    means: fall back to whatever `sys.executable` is."""
    if WINDOWS:
        rel = [("python.exe",), ("Scripts", "python.exe")]  # runtime, venv
    else:
        rel = [("bin", "python3"), ("bin", "python")]
    roots = [PYTHON_RUNTIME_DIR, *sorted(PYTHON_RUNTIME_DIR.glob("cpython-*"))]
    for root in roots:
        for parts in rel:
            candidate = root.joinpath(*parts)
            if candidate.exists():
                return str(candidate)
    return None
