"""End-to-end check of a packaged AUGA-Builder build. CI runs this on
Windows, macOS and Linux after building; it only uses the standard library.

    python build/smoke_test.py <path to the AUGA-Builder executable> [--expect-mode window]

It launches the app normally (its window opens; isolated home folder), then
checks that:
  1. the server comes up, reports it's the packaged app, and shows the
     expected kind of window (--expect-mode, comma-separated alternatives),
  2. a bundled example script really runs on the bundled Python runtime and
     reaches its first input() prompt,
  3. launching the app a second time brings the existing window back
     instead of starting a duplicate,
  4. Quit closes the window and stops the app.
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
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8756"


def call(method: str, path: str, body: dict | None = None, timeout: float = 5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


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
        # the mode is set once the window is being created
        info = wait_for(lambda: (i := call("GET", "/api/app-info"))["mode"] and i, 30, "the window")
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
