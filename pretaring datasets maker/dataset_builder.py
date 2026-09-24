#!/usr/bin/env python3
"""
dataset_builder.py

Converts local files (recursively, from any folder you point it at) and/or
web links into a pretraining-style dataset with columns: id, text, source,
filetype. Saved as Parquet by default (JSONL also supported).

Run it with no arguments and use the numbered menu:
    python dataset_builder.py

Menu options: set the local folder to scan (1), add web links (2), set the
output folder (3), output filename (4), output format (5), minimum token
filter (6), toggle duplicate removal (7), then build the dataset (8).
"""

import hashlib
import json
import sys
from pathlib import Path

import pandas as pd
import requests

try:
    import trafilatura
    HAVE_TRAFILATURA = True
except ImportError:
    HAVE_TRAFILATURA = False

try:
    from bs4 import BeautifulSoup
    HAVE_BS4 = True
except ImportError:
    HAVE_BS4 = False

_ENC = None
try:
    import tiktoken
    _ENC = tiktoken.get_encoding("cl100k_base")
except Exception:
    # tiktoken not installed, or its encoding file couldn't be downloaded
    # (e.g. no network access to openaipublic.blob.core.windows.net)
    _ENC = None


def count_tokens(text: str) -> int:
    if _ENC is not None:
        return len(_ENC.encode(text, disallowed_special=()))
    # rough fallback: ~4 chars per token (English text/code average)
    return max(1, len(text) // 4)


SUPPORTED_EXTENSIONS = {
    ".py", ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".rst",
    ".js", ".ts", ".c", ".cpp", ".h", ".java", ".go", ".rs",
}


def clean_text(text: str) -> str:
    """Basic whitespace normalization. Keeps code/markdown structure intact."""
    lines = [line.rstrip() for line in text.splitlines()]
    cleaned_lines = []
    blank_run = 0
    for line in lines:
        if line == "":
            blank_run += 1
            if blank_run <= 1:
                cleaned_lines.append(line)
        else:
            blank_run = 0
            cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip()


def read_local_file(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        print(f"  [skip] {path}: {e}", file=sys.stderr)
        return None


def fetch_url_text(url: str) -> str | None:
    try:
        if HAVE_TRAFILATURA:
            downloaded = trafilatura.fetch_url(url)
            if downloaded:
                extracted = trafilatura.extract(downloaded, include_comments=False, include_tables=False)
                if extracted:
                    return extracted
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        if HAVE_BS4:
            soup = BeautifulSoup(resp.text, "html.parser")
            for tag in soup(["script", "style", "nav", "header", "footer", "aside"]):
                tag.decompose()
            return soup.get_text(separator="\n")
        return resp.text
    except Exception as e:
        print(f"  [skip] {url}: {e}", file=sys.stderr)
        return None


def collect_local_files(input_dir: Path):
    """Recursively walk input_dir, including every subfolder underneath it."""
    for path in sorted(input_dir.rglob("*")):
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
            yield path


def build_records(input_dir: Path | None, urls: list[str], min_tokens: int, dedup: bool):
    records = []           # each: {"text":..., "source":..., "filetype":...} — id added later
    seen_hashes = set()
    counts_by_type = {}    # filetype -> [doc_count, char_count, token_count], print-only

    def add_record(text, source, filetype):
        if not text or not text.strip():
            return
        cleaned = clean_text(text)
        char_count = len(cleaned)
        token_count = count_tokens(cleaned)
        if token_count < min_tokens:
            print(f"  [drop-short] {source} ({token_count} tokens)")
            return
        if dedup:
            h = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()
            if h in seen_hashes:
                print(f"  [drop-dup] {source}")
                return
            seen_hashes.add(h)
        records.append({"text": cleaned, "source": source, "filetype": filetype})
        bucket = counts_by_type.setdefault(filetype, [0, 0, 0])
        bucket[0] += 1
        bucket[1] += char_count
        bucket[2] += token_count

    if input_dir:
        print(f"Scanning {input_dir} (including all subfolders) ...")
        for path in collect_local_files(input_dir):
            text = read_local_file(path)
            filetype = path.suffix.lstrip(".").lower()
            add_record(text, str(path), filetype)

    for url in urls:
        print(f"  fetching {url}")
        text = fetch_url_text(url)
        add_record(text, url, "web")

    return records, counts_by_type


def save_dataset(records: list[dict], output_dir: Path, output_name: str, fmt: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(records, columns=["text", "source", "filetype"])
    df.insert(0, "id", range(1, len(df) + 1))  # serial number column

    if fmt == "parquet":
        out_path = output_dir / f"{output_name}.parquet"
        df.to_parquet(out_path, index=False)
    else:
        out_path = output_dir / f"{output_name}.jsonl"
        with open(out_path, "w", encoding="utf-8") as f:
            for row in df.to_dict(orient="records"):
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    return out_path


def print_summary(counts_by_type: dict, out_path: Path):
    total_docs = sum(v[0] for v in counts_by_type.values())
    total_chars = sum(v[1] for v in counts_by_type.values())
    total_tokens = sum(v[2] for v in counts_by_type.values())

    print("\n--- Summary (counts below are NOT stored in the dataset file) ---")
    print(f"Documents written : {total_docs}")
    print(f"Total characters   : {total_chars:,}")
    print(f"Total tokens       : {total_tokens:,}")
    print("By filetype:")
    for filetype, (count, chars, tokens) in sorted(counts_by_type.items()):
        print(f"  {filetype:10s}: {count:5d} docs | {chars:10,d} chars | {tokens:10,d} tokens")
    print(f"Output             : {out_path}")


def print_menu(state: dict):
    print("\n" + "=" * 60)
    print("DATASET BUILDER")
    print("=" * 60)
    print(f" 1. Set local folder to scan       : {state['input_dir'] or '(not set)'}")
    print(f" 2. Add a web link                 : {len(state['urls'])} link(s) added")
    print(f" 3. Set output folder              : {state['output_dir'] or '(not set)'}")
    print(f" 4. Set output filename            : {state['output_name']}")
    print(f" 5. Set output format              : {state['format']}")
    print(f" 6. Set minimum tokens to keep doc : {state['min_tokens']}")
    print(f" 7. Toggle duplicate removal       : {'ON' if state['dedup'] else 'OFF'}")
    print(f" 8. Build dataset now")
    print(f" 9. Exit")
    print("-" * 60)


def prompt_dir(message: str) -> str | None:
    path_str = input(message).strip()
    if not path_str:
        print("  [cancelled — nothing entered]")
        return None
    path = Path(path_str).expanduser()
    if not path.is_dir():
        make_it = input(f"  '{path}' doesn't exist. Create it? [y/N]: ").strip().lower()
        if make_it == "y":
            path.mkdir(parents=True, exist_ok=True)
        else:
            print("  [cancelled]")
            return None
    return str(path)


def run_menu():
    state = {
        "input_dir": None,
        "urls": [],
        "output_dir": None,
        "output_name": "dataset",
        "format": "parquet",
        "min_tokens": 10,
        "dedup": False,
    }

    while True:
        print_menu(state)
        choice = input("Enter option number: ").strip()

        if choice == "1":
            path_str = input("Enter the folder to scan (all its subfolders are included too): ").strip()
            if path_str:
                path = Path(path_str).expanduser()
                if path.is_dir():
                    state["input_dir"] = str(path)
                else:
                    print(f"  [error] '{path}' is not a valid folder")

        elif choice == "2":
            while True:
                url = input("Enter a web link (leave blank to stop adding): ").strip()
                if not url:
                    break
                state["urls"].append(url)
                print(f"  added. total links: {len(state['urls'])}")

        elif choice == "3":
            out_dir = prompt_dir("Enter the folder to save the dataset into: ")
            if out_dir:
                state["output_dir"] = out_dir

        elif choice == "4":
            name = input("Enter output filename (without extension): ").strip()
            if name:
                state["output_name"] = name

        elif choice == "5":
            fmt = input("Enter format — 'parquet' or 'jsonl': ").strip().lower()
            if fmt in ("parquet", "jsonl"):
                state["format"] = fmt
            else:
                print("  [error] must be 'parquet' or 'jsonl'")

        elif choice == "6":
            val = input("Enter minimum token count to keep a document: ").strip()
            if val.isdigit():
                state["min_tokens"] = int(val)
            else:
                print("  [error] must be a whole number")

        elif choice == "7":
            state["dedup"] = not state["dedup"]
            print(f"  duplicate removal is now {'ON' if state['dedup'] else 'OFF'}")

        elif choice == "8":
            if not state["input_dir"] and not state["urls"]:
                print("  [error] set a local folder (1) and/or add web links (2) first")
                continue
            if not state["output_dir"]:
                print("  [error] set an output folder (3) first")
                continue

            input_dir = Path(state["input_dir"]) if state["input_dir"] else None
            output_dir = Path(state["output_dir"])
            records, counts_by_type = build_records(input_dir, state["urls"], state["min_tokens"], state["dedup"])
            out_path = save_dataset(records, output_dir, state["output_name"], state["format"])
            print_summary(counts_by_type, out_path)

        elif choice == "9":
            print("Goodbye.")
            break

        else:
            print("  [error] enter a number from 1-9")


if __name__ == "__main__":
    run_menu()