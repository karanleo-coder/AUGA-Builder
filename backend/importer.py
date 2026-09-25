"""Add scripts by giving the app a folder, a .zip file, or a single .py file.

The source is copied into the scripts folder as its own project folder,
its runnable scripts (entry points, not helper modules) are registered, and
a requirements.txt, if there is one, is reported so the caller can install
it. Zips come from anywhere, so extraction is defensive: no paths outside
the target folder, no symlinks, and limits on size and file count.
"""
from __future__ import annotations

import re
import shutil
import stat
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Optional

from appdirs import DATA_DIR, SCRIPTS_DIR
from models import ScriptInfo
from registry import JUNK_DIRS, find_entry_points, registry

MAX_FILES = 5000
MAX_TOTAL_BYTES = 500 * 1024 * 1024  # 500 MB unpacked
STAGING_DIR = DATA_DIR / "imports"
_JUNK_FILES = {".DS_Store", "Thumbs.db", "desktop.ini"}


class ImportError_(Exception):
    """Something the user needs to fix (shown as-is in the app)."""


class ImportConflict(Exception):
    """A project folder with this name already exists."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name


@dataclass
class ImportResult:
    folder: Path
    scripts: list[ScriptInfo] = field(default_factory=list)
    requirements: Optional[Path] = None


# ------------------------------------------------------------- path safety

def safe_relative(path: str) -> Optional[PurePosixPath]:
    """A relative path that can't escape its folder, or None to skip it."""
    p = PurePosixPath(path.replace("\\", "/"))
    if p.is_absolute() or not p.parts or re.match(r"^[A-Za-z]:", p.parts[0]):
        return None
    if any(part in ("", ".", "..") for part in p.parts):
        return None
    if any(part in JUNK_DIRS for part in p.parts[:-1]) or p.name in _JUNK_FILES:
        return None
    return p


def safe_folder_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9 _.\-]+", "", name).strip(" .")
    return name[:80] or "Imported scripts"


# --------------------------------------------------------------- sources

def _extract_zip(zip_path: Path, dest: Path) -> None:
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise ImportError_("That file isn't a valid .zip archive.")
    with zf:
        members = [m for m in zf.infolist() if not m.is_dir()]
        if len(members) > MAX_FILES:
            raise ImportError_(f"The zip has too many files (over {MAX_FILES}).")
        if sum(m.file_size for m in members) > MAX_TOTAL_BYTES:
            raise ImportError_("The zip is too big once unpacked (over 500 MB).")
        for m in members:
            if stat.S_ISLNK(m.external_attr >> 16):
                continue  # never create symlinks from an archive
            rel = safe_relative(m.filename)
            if rel is None:
                continue
            target = dest.joinpath(*rel.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _copy_folder(src: Path, dest: Path) -> None:
    count = total = 0
    for path in sorted(src.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        rel = safe_relative(path.relative_to(src).as_posix())
        if rel is None:
            continue
        count += 1
        total += path.stat().st_size
        if count > MAX_FILES:
            raise ImportError_(f"That folder has too many files (over {MAX_FILES}).")
        if total > MAX_TOTAL_BYTES:
            raise ImportError_("That folder is too big (over 500 MB).")
        target = dest.joinpath(*rel.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _single_top_folder(root: Path) -> Optional[Path]:
    """my_tool.zip often contains just one folder my_tool/ — use that."""
    items = [p for p in root.iterdir() if p.name not in _JUNK_FILES]
    return items[0] if len(items) == 1 and items[0].is_dir() else None


# ------------------------------------------------------------------ import

def import_path(source: Path, name: Optional[str] = None, replace: bool = False) -> ImportResult:
    """Import a folder, a .zip or a .py file from the local disk."""
    source = source.expanduser()
    if not source.exists():
        raise ImportError_(f"{source} doesn't exist.")
    resolved = source.resolve()
    in_scripts = SCRIPTS_DIR.resolve() in [resolved, *resolved.parents]
    in_staging = STAGING_DIR.resolve() in resolved.parents
    if source.is_dir() and in_scripts and not in_staging:
        raise ImportError_("That folder is already inside your scripts folder. Use Rescan instead.")

    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    work = STAGING_DIR / f"work-{uuid.uuid4().hex}"
    work.mkdir()
    try:
        if source.is_dir():
            _copy_folder(source, work)
            default_name = source.name
        elif source.suffix.lower() == ".zip":
            _extract_zip(source, work)
            default_name = source.stem
        elif source.suffix.lower() == ".py":
            shutil.copy2(source, work / source.name)
            default_name = source.stem
        else:
            raise ImportError_("Choose a folder, a .zip file or a .py file.")

        root = work
        inner = _single_top_folder(work)
        if inner is not None:
            root, default_name = inner, inner.name

        if not find_entry_points(root):
            raise ImportError_("No Python scripts (.py files) were found in it.")

        folder_name = safe_folder_name(name or default_name)
        dest = SCRIPTS_DIR / folder_name
        if dest.exists():
            if not replace:
                raise ImportConflict(folder_name)
            registry.remove_under(dest)
            shutil.rmtree(dest)

        SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(root), str(dest))
        scripts = registry.register_folder(dest)
        req = dest / "requirements.txt"
        return ImportResult(folder=dest, scripts=scripts, requirements=req if req.is_file() else None)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ----------------------------------------------- uploads from the web page
# The page can't hand the server a path (browser/app-window mode, or a
# drag-and-drop), so it uploads the files into a staging folder first.

_UPLOAD_ID = re.compile(r"^[0-9a-f]{32}$")


def new_upload() -> str:
    upload_id = uuid.uuid4().hex
    (STAGING_DIR / f"upload-{upload_id}").mkdir(parents=True)
    return upload_id


def upload_dir(upload_id: str) -> Path:
    if not _UPLOAD_ID.match(upload_id):
        raise ImportError_("Unknown upload.")
    d = STAGING_DIR / f"upload-{upload_id}"
    if not d.is_dir():
        raise ImportError_("Unknown upload.")
    return d


def upload_target(upload_id: str, rel_path: str) -> Optional[Path]:
    rel = safe_relative(rel_path)
    if rel is None:
        return None
    target = upload_dir(upload_id).joinpath(*rel.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def finish_upload(upload_id: str, name: Optional[str], replace: bool) -> ImportResult:
    """The upload is either one .zip / .py file, or a folder's files (whose
    first path part is the folder's name)."""
    d = upload_dir(upload_id)
    items = [p for p in d.iterdir() if p.name not in _JUNK_FILES]
    if not items:
        raise ImportError_("Nothing was uploaded.")
    source = items[0] if len(items) == 1 else d
    if source == d and not name:
        name = "Imported scripts"  # several loose files were dropped
    result = import_path(source, name=name, replace=replace)
    discard_upload(upload_id)  # kept until success, so "Replace?" can retry
    return result


def discard_upload(upload_id: str) -> None:
    try:
        shutil.rmtree(upload_dir(upload_id), ignore_errors=True)
    except ImportError_:
        pass


def cleanup_stale_staging() -> None:
    """Leftovers from a crash or an abandoned upload."""
    if STAGING_DIR.exists():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
