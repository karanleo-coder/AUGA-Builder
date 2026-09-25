"""End-to-end check of a packaged AUGA-Builder build. CI runs this on
Windows, macOS and Linux after building; it only uses the standard library.

    python build/smoke_test.py <path to the AUGA-Builder executable> [--expect-mode window]

It launches the app normally (its window opens; isolated home folder), then
checks that:
  1. the server comes up, reports it's the packaged app, and shows the
     expected kind of window (--expect-mode, comma-separated alternatives),
  2. a bundled example script really runs on the bundled Python runtime and
     reaches its first input() prompt,
  3. a folder and a .zip can be added (entry points found, junk skipped,
     path escapes blocked, "replace" works) and their scripts run,
  4. a script using auga_ui.py gets tables, buttons and file questions,
  5. the Data Editor edits a file and converts it between all its formats,
  6. requests from other websites are refused,
  7. launching the app a second time brings the existing window back
     instead of starting a duplicate,
  8. Quit closes the window and stops the app.
On failure it prints the app's launcher.log.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

BASE = "http://127.0.0.1:8756"


def call(method: str, path: str, body: dict | None = None, timeout: float = 5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def status_of(method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> int:
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def upload(files: dict[str, bytes]) -> str:
    """Upload files like the page does (browser mode / drag-and-drop)."""
    upload_id = call("POST", "/api/import/uploads", {})["id"]
    for rel, data in files.items():
        q = urllib.parse.quote(rel)
        assert status_of("PUT", f"/api/import/uploads/{upload_id}?path={q}", data) == 200
    return upload_id


def run_to_end(script_id: str, timeout: float = 60) -> dict:
    run = call("POST", "/api/runs", {"script_id": script_id})
    return wait_for(
        lambda: (r := call("GET", f"/api/runs/{run['id']}"))["status"] not in ("running", "awaiting_input") and r,
        timeout, "the imported script to finish")


def check_imports() -> None:
    # 1) a .zip with one top folder: an entry point, a helper module, junk,
    #    and a hostile entry trying to write outside the target folder
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("silver_tool/main.py",
                   "import helpers\nif __name__ == '__main__':\n    print(helpers.greet())\n")
        z.writestr("silver_tool/helpers.py", "def greet():\n    return 'hello from an imported zip'\n")
        z.writestr("silver_tool/node_modules/junk.js", "x")
        z.writestr("../escaped.py", "print('should never be written')\n")
    uid = upload({"silver_tool.zip": buf.getvalue()})
    res = call("POST", f"/api/import/uploads/{uid}/finish", {}, timeout=30)
    folder = Path(res["folder"])
    names = [s["name"] for s in res["scripts"]]
    assert names == ["Silver Tool"], f"expected only the entry point, got {names}"
    assert not (folder / "node_modules").exists(), "junk folder was imported"
    assert not (folder.parent / "escaped.py").exists() and not (folder.parent.parent / "escaped.py").exists(), \
        "zip entry escaped the target folder"
    r = run_to_end(res["scripts"][0]["id"])
    out = [l["text"] for l in r["log"] if l["stream"] == "out"]
    assert r["status"] == "completed" and "hello from an imported zip" in out, r
    print("ok  imported a .zip: found its entry point, skipped junk, blocked path escape, ran it")

    # 2) the same name again -> conflict, then replace
    uid = upload({"silver_tool.zip": buf.getvalue()})
    assert status_of("POST", f"/api/import/uploads/{uid}/finish", b"{}",
                     {"Content-Type": "application/json"}) == 409
    call("POST", f"/api/import/uploads/{uid}/finish", {"replace": True}, timeout=30)
    print("ok  importing it again asks before replacing")

    # 3) a folder (files uploaded with their relative paths)
    uid = upload({
        "bar_counter/app.py": b"from lib.count import total\nprint('bars:', total())\n",
        "bar_counter/lib/count.py": b"def total():\n    return 3\n",
        "bar_counter/lib/__init__.py": b"",
    })
    res = call("POST", f"/api/import/uploads/{uid}/finish", {}, timeout=30)
    assert [s["name"] for s in res["scripts"]] == ["Bar Counter"], res["scripts"]
    r = run_to_end(res["scripts"][0]["id"])
    assert r["status"] == "completed" and "bars: 3" in [l["text"] for l in r["log"]], r
    print("ok  imported a folder with a package inside and ran it")


def check_ui_helper(workdir: Path) -> None:
    """A script using script-helpers/auga_ui.py shows a message, a table,
    choice buttons and a file question in the app (not plain text), and its
    answers arrive like typed input."""
    helper = (Path(__file__).resolve().parent.parent / "script-helpers" / "auga_ui.py").read_bytes()
    demo = b"""import os
import auga_ui as ui

if __name__ == "__main__":
    ui.message("Hello from a script", kind="success")
    ui.table([["Silver bar", 1000], ["Silver coin", 31]], columns=["metal", "grams"], title="Vault")
    ui.progress(50)
    pick = ui.choose("Which one?", [("bar", "Silver bar"), ("coin", "Silver coin")])
    path = ui.ask_path("Where to save?", kind="save", extensions=[".txt"], default="out.txt")
    ui.progress(None)
    with open(path, "w") as f:
        f.write(pick)
    ui.message("Saved " + pick + " to " + os.path.basename(path), kind="success")
"""
    uid = upload({"ui_demo/ui_demo.py": demo, "ui_demo/auga_ui.py": helper})
    res = call("POST", f"/api/import/uploads/{uid}/finish", {}, timeout=30)
    assert [s["name"] for s in res["scripts"]] == ["Ui Demo"], res["scripts"]  # not the helper module
    run = call("POST", "/api/runs", {"script_id": res["scripts"][0]["id"]})
    out = workdir / "picked.txt"
    last_seq = 0
    for answer in ["coin", str(out)]:
        r = wait_for(lambda: (x := call("GET", f"/api/runs/{run['id']}"))["status"] != "running"
                     and (x["status"] != "awaiting_input" or x["log"][-1]["seq"] > last_seq) and x,
                     60, f"the demo script to ask (before answering {answer!r})")
        assert r["status"] == "awaiting_input", r["log"][-10:]
        last_seq = r["log"][-1]["seq"]
        call("POST", f"/api/runs/{run['id']}/input", {"text": answer})
    r = wait_for(lambda: (x := call("GET", f"/api/runs/{run['id']}"))["status"] not in ("running", "awaiting_input") and x,
                 60, "the demo script to finish")
    kinds = {json.loads(l["text"])["type"] for l in r["log"] if l["stream"] == "ui"}
    raw = [l for l in r["log"] if l["stream"] == "out" and l["text"].startswith("@@auga:")]
    assert r["status"] == "completed", r["log"][-10:]
    assert {"message", "table", "choices", "ask_path"} <= kinds and not raw, (kinds, raw[:2])
    assert out.read_text() == "coin"
    print("ok  a script using auga_ui showed a message, table, buttons and a file question")


def check_data_editor(workdir: Path) -> None:
    """The Data Editor: open a JSON file, edit cells (a bad value is refused),
    add a row and a column, then save it as every format and reopen each:
    same rows, and dates stay dates."""
    src = workdir / "vault.json"
    src.write_text(json.dumps([
        {"metal": "Silver bar", "grams": 1000, "minted": "2026-09-20", "pure": True},
        {"metal": "Silver coin", "grams": 31, "minted": "2026-09-22", "pure": False},
    ]))
    meta = call("POST", "/api/data/open", {"path": str(src)}, timeout=30)
    kinds = {c["name"]: c["kind"] for c in meta["columns"]}
    assert kinds == {"metal": "text", "grams": "integer", "minted": "date", "pure": "boolean"}, kinds
    sid = meta["id"]
    res = call("POST", f"/api/data/{sid}/edit", {"op": "set", "cells": [[0, 0, "Silver ingot"], [1, 1, "abc"]]})
    assert res["changed"] == 1 and res["error_count"] == 1, res
    call("POST", f"/api/data/{sid}/edit", {"op": "insert_rows", "at": 2, "count": 1})
    call("POST", f"/api/data/{sid}/edit", {"op": "set", "cells": [[2, 0, "Silver biscuit"], [2, 1, "100"], [2, 2, "2026-09-26"]]})
    call("POST", f"/api/data/{sid}/edit", {"op": "add_column", "name": "vault", "kind": "text"})
    expected = [["Silver ingot", 1000, "2026-09-20", True, None],
                ["Silver coin", 31, "2026-09-22", False, None],
                ["Silver biscuit", 100, "2026-09-26", None, None]]
    for fmt, ext in [("parquet", ".parquet"), ("arrow", ".arrow"), ("jsonl", ".jsonl"), ("csv", ".csv"), ("json", ".json")]:
        out = workdir / f"converted{ext}"
        saved = call("POST", f"/api/data/{sid}/save", {"format": fmt, "path": str(out), "overwrite": True}, timeout=30)
        assert saved["format"] == fmt and out.is_file(), saved
        back = call("POST", "/api/data/open", {"path": str(out)}, timeout=30)
        rows = call("GET", f"/api/data/{back['id']}/rows?offset=0&limit=10")["rows"]
        assert rows == expected, (fmt, rows)
        assert {c["name"]: c["kind"] for c in back["columns"]}["minted"] == "date", (fmt, back["columns"])
        call("DELETE", f"/api/data/{back['id']}")
    print("ok  Data Editor edited a file and converted it to Parquet, Arrow, JSONL, CSV and JSON")

    # Clean data: duplicates keep the most complete copy; keyword search, replace, remove.
    call("POST", f"/api/data/{sid}/edit", {"op": "insert_rows", "at": 3, "count": 1})
    call("POST", f"/api/data/{sid}/edit", {"op": "set", "cells": [[3, 0, "silver COIN "], [3, 3, "N/A"]]})
    dups = call("POST", f"/api/data/{sid}/clean", {"tool": "duplicates", "cols": [0]})
    assert dups["total_groups"] == 1 and dups["suggested_count"] == 1, dups
    assert [r["i"] for r in dups["groups"][0]["rows"]] == [1, 3], dups  # the fuller copy first
    found = call("POST", f"/api/data/{sid}/clean", {"tool": "find", "text": "ingot", "cols": [0]})
    assert [r["i"] for r in found["rows"]] == [0], found
    res = call("POST", f"/api/data/{sid}/edit", {"op": "replace_text", "replacement": "bar", "selection": {
        "tool": "find", "text": "ingot", "cols": [0], "base": "all", "add": [], "skip": []}})
    assert res["changed"] == 1, res
    res = call("POST", f"/api/data/{sid}/edit", {"op": "remove_found", "selection": {
        "tool": "duplicates", "cols": [0], "base": "suggested", "add": [], "skip": []}})
    assert res["removed"] == 1, res
    rows = call("GET", f"/api/data/{sid}/rows?offset=0&limit=10")["rows"]
    assert [r[0] for r in rows] == ["Silver bar", "Silver coin", "Silver biscuit"], rows
    print("ok  Clean data found a duplicate, found and replaced a keyword, and removed the extra copy")


def check_local_only() -> None:
    evil = {"Origin": "https://evil.example", "Content-Type": "application/json"}
    assert status_of("POST", "/api/packages", b'{"packages": "requests"}', evil) == 403
    assert status_of("GET", "/api/scripts", None, {"Host": "evil.example:8756"}) == 403
    assert status_of("GET", "/api/scripts", None, {"Origin": BASE}) == 200
    print("ok  requests from other websites are refused")


def wait_for(check, timeout: float, what: str):
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            result = check()
            if result:
                return result
        except Exception as e:  # noqa: BLE001 - keep polling
            last_err = e
        time.sleep(1)
    raise AssertionError(f"timed out waiting for {what} (last error: {last_err})")


def server_up() -> bool:
    return call("GET", "/api/health", timeout=2).get("app") == "AUGA-Builder"


def server_down() -> bool:
    try:
        call("GET", "/api/health", timeout=1)
        return False
    except (urllib.error.URLError, OSError):
        return True


def main() -> int:
    exe = Path(sys.argv[1]).resolve()
    expect = None
    if "--expect-mode" in sys.argv:
        expect = sys.argv[sys.argv.index("--expect-mode") + 1].split(",")
    home = Path(tempfile.mkdtemp(prefix="auga-home-"))
    env = dict(os.environ, HOME=str(home), USERPROFILE=str(home))
    proc = subprocess.Popen([str(exe)], env=env)

    try:
        wait_for(server_up, 90, "the server to start")
        info = call("GET", "/api/app-info")
        assert info["packaged"] is True, info
        # the window mode is set a moment later, once the window is attached
        info = wait_for(lambda: (i := call("GET", "/api/app-info"))["mode"] and i, 60, "the window")
        if expect:
            assert info["mode"] in expect, f"expected window mode {expect}, got {info['mode']!r}"
            if info["mode"] != expect[0]:
                # Allowed fallback, but make it visible in the GitHub run.
                print(f"::warning::app fell back to {info['mode']!r} instead of {expect[0]!r}")
        print("ok  app is up, showing:", info["mode"])

        scripts = call("GET", "/api/scripts")
        finder = next(s for s in scripts if "github_repo_finder" in s["path"])
        run = call("POST", "/api/runs", {"script_id": finder["id"]})

        def first_prompt():
            r = call("GET", f"/api/runs/{run['id']}")
            if r["status"] == "failed":
                raise AssertionError("script failed:\n" + "\n".join(l["text"] for l in r["log"]))
            return r if r["status"] == "awaiting_input" else None

        r = wait_for(first_prompt, 60, "the example script's first prompt")
        print(f"ok  bundled Python ran a script, which asked: {r['awaiting_prompt']!r}")
        call("POST", f"/api/runs/{run['id']}/kill")

        check_imports()
        check_ui_helper(home)
        check_data_editor(home)
        check_local_only()

        second = subprocess.run([str(exe)], env=env, timeout=60)
        assert second.returncode == 0, f"second launch exited with {second.returncode}"
        assert server_up(), "first instance died when launching a second time"
        print("ok  second launch brought back the running app instead of starting another")

        call("POST", "/api/shutdown")
        wait_for(server_down, 20, "the app to stop after Quit")
        proc.wait(timeout=20)
        print("ok  Quit closed the window and stopped the app")
        print("SMOKE TEST PASSED")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"SMOKE TEST FAILED: {e}", file=sys.stderr)
        # macOS .app keeps its data in ~/AUGA-Builder; Windows/Linux next to the exe.
        for log in (home / "AUGA-Builder" / "data" / "launcher.log",
                    exe.parent / "data" / "launcher.log"):
            if not log.exists():
                continue
            print(f"\n----- {log} -----", file=sys.stderr)
            print(log.read_text(errors="replace")[-8000:], file=sys.stderr)
        return 1
    finally:
        if proc.poll() is None:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
