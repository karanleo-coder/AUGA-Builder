"""Script registry: discovers + persists the list of Python scripts the
frontend knows about. Backed by a small JSON file so new scripts registered
via Settings survive a backend restart, and pre-seeded with any .py files
already present in the project folder on first run.
"""
from __future__ import annotations

import ast
import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from appdirs import DATA_DIR, FROZEN, SCRIPTS_DIR, SEED_SCRIPTS_DIR
from models import ScriptCreate, ScriptInfo, ScriptUpdate

REGISTRY_PATH = DATA_DIR / "registry.json"

# Folders that never hold scripts (virtualenvs, caches, VCS, macOS zip junk).
JUNK_DIRS = {
    ".git", ".hg", ".svn", ".venv", "venv", "env", "node_modules", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".idea", ".vscode",
    "__MACOSX", "site-packages",
}
# In dev mode the whole repo is scanned, so skip the app's own folders too.
IGNORE_DIRS = JUNK_DIRS if FROZEN else JUNK_DIRS | {"data", "backend", "frontend", "dist", "build", "assets"}

# Files that are never something you'd "run".
NOT_ENTRY_FILES = {"__init__.py", "setup.py", "conftest.py"}
GENERIC_ENTRY_NAMES = {"main", "app", "run", "cli", "start", "__main__"}
_MAIN_GUARD = re.compile(r"""if\s+__name__\s*==\s*['"]__main__['"]""")


def is_ignored(path: Path, root: Path) -> bool:
    """True if `path` sits inside a junk folder (only looks below `root`)."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        parts = path.parts
    return any(p in IGNORE_DIRS or (p.startswith(".") and p not in {".", ".."}) for p in parts[:-1])


def _has_main_guard(py: Path) -> bool:
    try:
        return bool(_MAIN_GUARD.search(py.read_text(encoding="utf-8", errors="ignore")))
    except OSError:
        return False


def find_entry_points(root: Path) -> list[Path]:
    """The runnable scripts in a project folder, not its helper modules:
    files with `if __name__ == "__main__":`; otherwise main.py/app.py/...;
    otherwise the top-level .py files (or, failing that, every .py file)."""
    pys = sorted(
        p for p in root.rglob("*.py")
        if p.is_file()
        and not is_ignored(p, root)
        and p.name not in NOT_ENTRY_FILES
        and not p.name.startswith("test_")
        and not p.name.endswith("_test.py")
    )
    if not pys:
        return []
    guarded = [p for p in pys if _has_main_guard(p)]
    if guarded:
        return guarded
    named = [p for p in pys if p.stem in GENERIC_ENTRY_NAMES]
    if named:
        return named
    top = [p for p in pys if p.parent == root]
    return top or pys

DEFAULT_ICONS = ["download", "search", "database", "sparkles", "rocket", "terminal", "cpu", "globe"]
DEFAULT_COLORS = ["violet", "sky", "emerald", "amber", "rose", "cyan", "fuchsia", "lime"]


def _guess_description(py_path: Path) -> str:
    """Pull the module docstring's first meaningful paragraph, if any."""
    try:
        source = py_path.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(source)
        doc = ast.get_docstring(tree)
        if not doc:
            return ""
        # Skip the filename-echo line often used as a title, keep first real paragraph.
        paragraphs = [p.strip() for p in doc.split("\n\n") if p.strip()]
        for p in paragraphs:
            lines = [l.strip() for l in p.splitlines() if l.strip()]
            joined = " ".join(lines)
            if joined and not joined.endswith(".py"):
                return joined[:280]
        return ""
    except Exception:
        return ""


def _pretty_name(py_path: Path) -> str:
    # "my_tool/main.py" reads better as "My Tool" than "Main".
    base = py_path.parent.name if py_path.stem in GENERIC_ENTRY_NAMES else py_path.stem
    return base.replace("_", " ").replace("-", " ").strip().title() or "Script"


class Registry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._scripts: dict[str, ScriptInfo] = {}
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._seed_scripts_dir()
        self._load()
        self._auto_discover()

    def _seed_scripts_dir(self) -> None:
        """Packaged mode only: on first run, create the `scripts` folder next
        to the executable and copy the bundled demo scripts into it, so
        someone who just downloaded the app has something to click Run on."""
        if not FROZEN:
            return
        SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
        already_has_scripts = any(SCRIPTS_DIR.rglob("*.py"))
        if already_has_scripts or not SEED_SCRIPTS_DIR.exists():
            return
        for item in SEED_SCRIPTS_DIR.iterdir():
            dest = SCRIPTS_DIR / item.name
            if dest.exists():
                continue
            try:
                if item.is_dir():
                    shutil.copytree(item, dest)
                else:
                    shutil.copy2(item, dest)
            except OSError:
                pass

    # ---------- persistence ----------

    def _load(self) -> None:
        if REGISTRY_PATH.exists():
            try:
                raw = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
                for item in raw:
                    info = ScriptInfo(**item)
                    if Path(info.path).exists():
                        self._scripts[info.id] = info
            except Exception:
                pass

    def _save(self) -> None:
        payload = [s.model_dump() for s in self._scripts.values()]
        REGISTRY_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def _new_info(self, py_path: Path) -> ScriptInfo:
        idx = len(self._scripts)
        return ScriptInfo(
            id=str(uuid.uuid4()),
            name=_pretty_name(py_path),
            description=_guess_description(py_path),
            path=str(py_path),
            folder=py_path.parent.name,
            icon=DEFAULT_ICONS[idx % len(DEFAULT_ICONS)],
            color=DEFAULT_COLORS[idx % len(DEFAULT_COLORS)],
            created_at=time.time(),
        )

    def _register_paths(self, paths: list[Path]) -> list[ScriptInfo]:
        """Register any of `paths` not known yet; returns all of them."""
        by_path = {s.path: s for s in self._scripts.values()}
        result = []
        for py in paths:
            info = by_path.get(str(py))
            if info is None:
                info = self._new_info(py)
                self._scripts[info.id] = info
                by_path[info.path] = info
            result.append(info)
        return result

    def _auto_discover(self) -> None:
        """Pick up new scripts: each folder inside the scripts folder is one
        project (only its entry points get registered, not helper modules);
        loose .py files directly in the scripts folder are scripts too."""
        if not SCRIPTS_DIR.exists():
            return
        before = len(self._scripts)
        found: list[Path] = []
        for child in sorted(SCRIPTS_DIR.iterdir()):
            if child.name in IGNORE_DIRS or child.name.startswith("."):
                continue
            if child.is_dir():
                found += find_entry_points(child)
            elif child.suffix == ".py" and child.name not in NOT_ENTRY_FILES:
                found.append(child)
        self._register_paths(found)
        if len(self._scripts) != before:
            self._save()

    def register_folder(self, folder: Path) -> list[ScriptInfo]:
        """Register the runnable scripts in one (newly added) project folder."""
        with self._lock:
            entries = find_entry_points(folder)
            known = {s.path for s in self._scripts.values()}
            infos = self._register_paths(entries)
            # A project with a single script is named after the project
            # ("Currency Converter"), not its file ("Convert").
            if len(infos) == 1 and infos[0].path not in known:
                pretty = folder.name.replace("_", " ").replace("-", " ").strip().title()
                if pretty:
                    infos[0] = infos[0].model_copy(update={"name": pretty})
                    self._scripts[infos[0].id] = infos[0]
            self._save()
            return infos

    def remove_under(self, folder: Path) -> None:
        """Forget every script inside `folder` (it's being replaced)."""
        folder = folder.resolve()
        with self._lock:
            for sid, info in list(self._scripts.items()):
                p = Path(info.path).resolve()
                if p == folder or folder in p.parents:
                    del self._scripts[sid]
            self._save()

    # ---------- public API ----------

    def list(self) -> list[ScriptInfo]:
        with self._lock:
            return sorted(self._scripts.values(), key=lambda s: (s.folder, s.name))

    def get(self, script_id: str) -> Optional[ScriptInfo]:
        with self._lock:
            return self._scripts.get(script_id)

    def rescan(self) -> list[ScriptInfo]:
        with self._lock:
            self._auto_discover()
            return sorted(self._scripts.values(), key=lambda s: (s.folder, s.name))

    def create(self, payload: ScriptCreate) -> ScriptInfo:
        path = Path(payload.path).expanduser().resolve()
        if not path.exists() or path.suffix != ".py":
            raise ValueError("path must point to an existing .py file")
        with self._lock:
            idx = len(self._scripts)
            info = ScriptInfo(
                id=str(uuid.uuid4()),
                name=payload.name or _pretty_name(path),
                description=payload.description or _guess_description(path),
                path=str(path),
                folder=path.parent.name,
                icon=payload.icon or DEFAULT_ICONS[idx % len(DEFAULT_ICONS)],
                color=payload.color or DEFAULT_COLORS[idx % len(DEFAULT_COLORS)],
                created_at=time.time(),
            )
            self._scripts[info.id] = info
            self._save()
            return info

    def update(self, script_id: str, payload: ScriptUpdate) -> Optional[ScriptInfo]:
        with self._lock:
            info = self._scripts.get(script_id)
            if not info:
                return None
            data = info.model_dump()
            for field in ("name", "description", "icon", "color"):
                value = getattr(payload, field)
                if value is not None:
                    data[field] = value
            updated = ScriptInfo(**data)
            self._scripts[script_id] = updated
            self._save()
            return updated

    def delete(self, script_id: str) -> bool:
        with self._lock:
            if script_id in self._scripts:
                del self._scripts[script_id]
                self._save()
                return True
            return False

    def browse(self, rel_path: str = "") -> list[dict]:
        """List directory contents under the scripts root, for the Settings
        file picker. Never escapes SCRIPTS_DIR."""
        base = (SCRIPTS_DIR / rel_path).resolve()
        if SCRIPTS_DIR not in base.parents and base != SCRIPTS_DIR:
            base = SCRIPTS_DIR
        entries = []
        try:
            for child in sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
                if child.name.startswith(".") or child.name in IGNORE_DIRS:
                    continue
                entries.append({
                    "name": child.name,
                    "path": str(child.relative_to(SCRIPTS_DIR)),
                    "is_dir": child.is_dir(),
                    "is_python": child.is_file() and child.suffix == ".py",
                })
        except FileNotFoundError:
            pass
        return entries


registry = Registry()
