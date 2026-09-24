#!/usr/bin/env python3
"""
github_extension_downloader.py

Reads a JSON file of GitHub repos (the same format github_repo_finder.py
saves — a list of {"name", "full_name", "url", ...} objects), then for each
repo downloads ONLY the files matching the extension(s) you choose, saved
into a folder named after the project. Folder structure inside the repo is
preserved.

Run it with no arguments:
    python github_extension_downloader.py

Steps: 1) path to the JSON file  2) extensions to grab, comma-separated
(e.g. .py,.txt,.md)  3) output folder  4) GitHub token (optional — raises
your rate limit and lets you reach private repos you have access to).

Expected JSON shape (list of objects), only "url" or "full_name" and "name"
are actually required per entry:
[
  {
    "name": "public-apis",
    "full_name": "public-apis/public-apis",
    "description": "A collective list of free APIs",
    "url": "https://github.com/public-apis/public-apis",
    "stars": 469849,
    "language": "Python"
  }
]
"""

import getpass
import json
import re
import sys
from pathlib import Path

import requests

API_ROOT = "https://api.github.com"


def choose_json_path() -> Path:
    print("\nStep 1: Path to the JSON file with your repo list")
    while True:
        path_str = input("Enter the JSON file path: ").strip()
        if not path_str:
            print("  [error] can't be blank")
            continue
        path = Path(path_str).expanduser()
        if path.is_file():
            return path
        print(f"  [error] '{path}' doesn't exist")


def choose_extensions() -> list[str]:
    print("\nStep 2: Which file extensions do you want? (comma-separated)")
    print("  Example: .py,.txt,.md")
    while True:
        raw = input("Enter extensions: ").strip()
        if not raw:
            print("  [error] can't be blank")
            continue
        exts = []
        for part in raw.split(","):
            part = part.strip().lower()
            if not part:
                continue
            if not part.startswith("."):
                part = "." + part
            exts.append(part)
        if exts:
            return exts
        print("  [error] no valid extensions parsed")


def choose_output_dir() -> Path:
    print("\nStep 3: Where should downloaded project folders be saved?")
    while True:
        path_str = input("Enter output folder: ").strip()
        if not path_str:
            print("  [error] can't be blank")
            continue
        path = Path(path_str).expanduser()
        if path.is_dir():
            return path
        make_it = input(f"  '{path}' doesn't exist. Create it? [y/N]: ").strip().lower()
        if make_it == "y":
            path.mkdir(parents=True, exist_ok=True)
            return path


def choose_token() -> str | None:
    print("\nStep 4: GitHub authentication (optional)")
    print("  A token raises your API rate limit and allows access to private repos")
    print("  you can see. Leave blank to proceed anonymously.")
    try:
        token = getpass.getpass("GitHub token (input hidden, blank to skip): ").strip()
    except Exception:
        token = input("GitHub token (blank to skip): ").strip()
    return token or None


def load_repo_list(json_path: Path) -> list[dict]:
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        print(f"[error] couldn't read {json_path}: {e}", file=sys.stderr)
        return []
    if not isinstance(data, list):
        print(f"[error] {json_path} must contain a JSON list", file=sys.stderr)
        return []
    return data


def resolve_full_name(entry: dict) -> str | None:
    """Get owner/repo from an entry's full_name field, or parse it out of the url."""
    if entry.get("full_name"):
        return entry["full_name"]
    url = entry.get("url", "")
    match = re.search(r"github\.com/([^/]+/[^/]+?)(?:\.git)?/?$", url)
    if match:
        return match.group(1)
    return None


def get_default_branch(full_name: str, headers: dict) -> str | None:
    resp = requests.get(f"{API_ROOT}/repos/{full_name}", headers=headers, timeout=15)
    if resp.status_code != 200:
        print(f"  [error] couldn't look up {full_name} (status {resp.status_code})", file=sys.stderr)
        return None
    return resp.json().get("default_branch", "main")


def get_matching_files(full_name: str, branch: str, extensions: list[str], headers: dict) -> list[str]:
    resp = requests.get(
        f"{API_ROOT}/repos/{full_name}/git/trees/{branch}",
        params={"recursive": "1"},
        headers=headers,
        timeout=30,
    )
    if resp.status_code != 200:
        print(f"  [error] couldn't list files for {full_name} (status {resp.status_code})", file=sys.stderr)
        return []
    tree = resp.json().get("tree", [])
    matched = [
        item["path"] for item in tree
        if item.get("type") == "blob" and any(item["path"].lower().endswith(ext) for ext in extensions)
    ]
    return matched


def download_file(full_name: str, branch: str, path: str, dest_root: Path) -> bool:
    raw_url = f"https://raw.githubusercontent.com/{full_name}/{branch}/{path}"
    try:
        resp = requests.get(raw_url, timeout=30)
        if resp.status_code != 200:
            print(f"    [skip] {path} (status {resp.status_code})", file=sys.stderr)
            return False
        dest_path = dest_root / path
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        dest_path.write_bytes(resp.content)
        return True
    except requests.RequestException as e:
        print(f"    [skip] {path}: {e}", file=sys.stderr)
        return False


def process_repo(entry: dict, extensions: list[str], output_dir: Path, headers: dict) -> tuple[str, int]:
    full_name = resolve_full_name(entry)
    project_name = entry.get("name") or (full_name.split("/")[-1] if full_name else "unknown")

    if not full_name:
        print(f"  [skip] entry has no usable full_name/url: {entry}")
        return project_name, 0

    print(f"\nProcessing {full_name} ...")
    branch = get_default_branch(full_name, headers)
    if not branch:
        return project_name, 0

    matched_paths = get_matching_files(full_name, branch, extensions, headers)
    if not matched_paths:
        print(f"  no files matching {extensions} found")
        return project_name, 0

    print(f"  found {len(matched_paths)} matching file(s), downloading ...")
    dest_root = output_dir / project_name
    downloaded = 0
    for path in matched_paths:
        if download_file(full_name, branch, path, dest_root):
            downloaded += 1
            print(f"    [ok] {path}")

    return project_name, downloaded


def run_wizard():
    print("=" * 60)
    print("GITHUB EXTENSION DOWNLOADER")
    print("=" * 60)

    json_path = choose_json_path()
    extensions = choose_extensions()
    output_dir = choose_output_dir()
    token = choose_token()

    repo_list = load_repo_list(json_path)
    if not repo_list:
        print("\nNo repos to process — check the JSON file.")
        return

    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    print(f"\nExtensions to grab: {', '.join(extensions)}")
    print(f"{len(repo_list)} repo(s) to process ...")

    results = []
    for entry in repo_list:
        project_name, count = process_repo(entry, extensions, output_dir, headers)
        results.append((project_name, count))

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    total = 0
    for project_name, count in results:
        print(f"  {project_name:30s}: {count} file(s)")
        total += count
    print(f"\nTotal files downloaded: {total}")
    print(f"Saved under: {output_dir}")


if __name__ == "__main__":
    run_wizard()