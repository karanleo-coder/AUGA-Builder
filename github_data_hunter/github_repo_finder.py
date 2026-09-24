#!/usr/bin/env python3
"""
github_repo_finder.py

Step-based wizard that searches GitHub for open-source repos in a language
you pick, saves the top N results (name, description, link) to a JSON file,
and can star them on your GitHub account.

Run it with no arguments:
    python github_repo_finder.py

Steps: 1) pick a language  2) how many repos  3) GitHub token (for auth +
optional starring)  4) output folder  -> then it searches, saves the JSON,
lists every link it found, and (if you say yes) stars each repo for you.

GitHub note: "login" here means a Personal Access Token, not a
username/password — GitHub retired password auth for the API. Create one at
https://github.com/settings/tokens (classic token, "public_repo" scope is
enough to search + star public repos). You can also skip entering a token —
search still works, just rate-limited harder and starring won't be available.
"""

import getpass
import json
import sys
from pathlib import Path

import requests

COMMON_LANGUAGES = [
    "Python", "JavaScript", "TypeScript", "Go", "Rust",
    "Java", "C++", "C", "Ruby", "PHP",
]

API_URL = "https://api.github.com/search/repositories"
STAR_URL = "https://api.github.com/user/starred/{full_name}"


def choose_language() -> str:
    print("\nStep 1: Which language?")
    for i, lang in enumerate(COMMON_LANGUAGES, start=1):
        print(f"  {i}. {lang}")
    print(f"  {len(COMMON_LANGUAGES) + 1}. Other (type it yourself)")

    choice = input("Enter option number: ").strip()
    if choice.isdigit() and 1 <= int(choice) <= len(COMMON_LANGUAGES):
        return COMMON_LANGUAGES[int(choice) - 1]

    while True:
        custom = input("Type the language name (e.g. kotlin, elixir): ").strip()
        if custom:
            return custom
        print("  [error] can't be blank")


def choose_count() -> int:
    print("\nStep 2: How many NEW repos do you want this run?")
    print("  (Repos already saved in your output file are skipped automatically.)")
    while True:
        val = input("Enter a number (e.g. 20): ").strip()
        if val.isdigit() and int(val) > 0:
            return int(val)
        print("  [error] enter a whole number greater than 0")


def choose_token() -> str | None:
    print("\nStep 3: GitHub authentication")
    print("  Paste a Personal Access Token to search with your account and enable")
    print("  starring, or leave blank to search anonymously (no starring).")
    try:
        token = getpass.getpass("GitHub token (input hidden, blank to skip): ").strip()
    except Exception:
        token = input("GitHub token (blank to skip): ").strip()
    return token or None


def choose_output_dir() -> Path:
    print("\nStep 4: Where should the results be saved?")
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
        # loop back and ask again


def search_repos(language: str, count: int, token: str | None, existing_names: set) -> list[dict]:
    """Search GitHub, skipping any repo whose full_name is already in existing_names,
    and keep paginating until `count` NEW repos are found (or GitHub runs out / page
    limit hit)."""
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    new_repos = []
    collected_names = set()
    skipped_dupes = 0
    page = 1
    per_page = 100  # fetch generously per page since some results get filtered out as dupes

    print(f"\nSearching GitHub for {count} NEW {language} repositories (by stars) ...")
    while len(new_repos) < count and page <= 10:
        params = {
            "q": f"language:{language} fork:false",
            "sort": "stars",
            "order": "desc",
            "per_page": per_page,
            "page": page,
        }
        try:
            resp = requests.get(API_URL, headers=headers, params=params, timeout=15)
        except requests.RequestException as e:
            print(f"  [error] request failed: {e}", file=sys.stderr)
            break

        if resp.status_code == 401:
            print("  [error] GitHub rejected the token (401 Unauthorized). Continuing without auth won't work for a bad token — check it and rerun.", file=sys.stderr)
            break
        if resp.status_code == 403:
            print("  [error] rate-limited by GitHub (403). Try again shortly, or add a token if you weren't using one.", file=sys.stderr)
            break
        if resp.status_code != 200:
            print(f"  [error] GitHub API returned {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
            break

        items = resp.json().get("items", [])
        if not items:
            break

        for item in items:
            full_name = item["full_name"]
            if full_name in existing_names or full_name in collected_names:
                skipped_dupes += 1
                continue
            collected_names.add(full_name)
            new_repos.append(item)
            if len(new_repos) >= count:
                break

        page += 1

    if skipped_dupes:
        print(f"  (skipped {skipped_dupes} repo(s) already in your saved list)")
    if len(new_repos) < count:
        print(f"  [note] only found {len(new_repos)} new repo(s) — GitHub ran out of unique results for this language before reaching {count}.")

    trimmed = new_repos[:count]
    return [
        {
            "name": item["name"],
            "full_name": item["full_name"],
            "description": item.get("description") or "",
            "url": item["html_url"],
            "stars": item["stargazers_count"],
            "language": item.get("language") or "",
        }
        for item in trimmed
    ]



def star_repos(repos: list[dict], token: str) -> None:
    headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}"}
    print("\nStarring repos ...")
    for repo in repos:
        try:
            resp = requests.put(STAR_URL.format(full_name=repo["full_name"]), headers=headers, timeout=15)
            if resp.status_code == 204:
                print(f"  [starred] {repo['full_name']}")
            elif resp.status_code == 401:
                print("  [error] token rejected — stopping star attempts.", file=sys.stderr)
                return
            else:
                print(f"  [skip] {repo['full_name']} (status {resp.status_code})", file=sys.stderr)
        except requests.RequestException as e:
            print(f"  [skip] {repo['full_name']}: {e}", file=sys.stderr)


def load_existing(out_path: Path) -> list[dict]:
    if not out_path.is_file():
        return []
    try:
        data = json.loads(out_path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"  [warn] couldn't read existing file ({e}) — starting fresh.", file=sys.stderr)
    return []


def save_results(repos: list[dict], out_path: Path) -> None:
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(repos, f, ensure_ascii=False, indent=2)


def run_wizard():
    print("=" * 60)
    print("GITHUB REPO FINDER")
    print("=" * 60)

    language = choose_language()
    count = choose_count()
    token = choose_token()
    output_dir = choose_output_dir()

    out_path = output_dir / f"github_{language.lower().replace(' ', '_')}.json"
    existing_repos = load_existing(out_path)
    existing_names = {r["full_name"] for r in existing_repos}
    if existing_repos:
        print(f"\n{len(existing_repos)} repo(s) already saved in {out_path.name} — those will be skipped.")

    new_repos = search_repos(language, count, token, existing_names)

    if not new_repos:
        print("\nNo new repos found — nothing to add.")
        return

    print(f"\nFound {len(new_repos)} new repo(s).")

    if token:
        do_star = input("Star these new repos on your GitHub account? [y/N]: ").strip().lower()
        if do_star == "y":
            star_repos(new_repos, token)
    else:
        print("(No token provided, so starring is skipped.)")

    combined = existing_repos + new_repos
    combined.sort(key=lambda r: r["stars"], reverse=True)
    save_results(combined, out_path)

    print(f"\nSaved to: {out_path}")
    print(f"\n--- New this run ({len(new_repos)}) ---")
    for repo in new_repos:
        print(f"  [{repo['stars']:>6}★] {repo['full_name']:40s} {repo['url']}")

    print(f"\n--- All repos in file ({len(combined)}) ---")
    for repo in combined:
        print(f"  [{repo['stars']:>6}★] {repo['full_name']:40s} {repo['url']}")


if __name__ == "__main__":
    run_wizard()