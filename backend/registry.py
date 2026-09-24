"""Script registry: discovers + persists the list of Python scripts the
frontend knows about. Backed by a small JSON file so new scripts registered
via Settings survive a backend restart, and pre-seeded with any .py files
already present in the project folder on first run.
"""
from __future__ import annotations

import ast
import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from appdirs import DATA_DIR, FROZEN, SCRIPTS_DIR, SEED_SCRIPTS_DIR
from models import ScriptCreate, ScriptInfo, ScriptUpdate

REGISTRY_PATH = DATA_DIR / "registry.json"

# Folders we never want to treat as "script sources" when auto-discovering.
IGNORE_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", "data",
    "backend", "frontend", ".pytest_cache", "dist", "build",
}

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
    stem = py_path.stem.replace("_", " ").replace("-", " ")
    return stem.title()


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

    def _auto_discover(self) -> None:
        """On first boot (or whenever a folder has new .py files not yet
        registered), pick them up automatically so the sidebar isn't empty."""
        known_paths = {s.path for s in self._scripts.values()}
        changed = False
        for py_path in sorted(SCRIPTS_DIR.rglob("*.py")):
            if any(part in IGNORE_DIRS for part in py_path.parts):
                continue
            if str(py_path) in known_paths:
                continue
            idx = len(self._scripts)
            info = ScriptInfo(
                id=str(uuid.uuid4()),
                name=_pretty_name(py_path),
                description=_guess_description(py_path),
                path=str(py_path),
                folder=py_path.parent.name,
                icon=DEFAULT_ICONS[idx % len(DEFAULT_ICONS)],
                color=DEFAULT_COLORS[idx % len(DEFAULT_COLORS)],
                created_at=time.time(),
            )
            self._scripts[info.id] = info
            changed = True
        if changed:
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
