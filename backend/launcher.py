"""Entry point for the packaged desktop app (also runnable in dev mode:
`python backend/launcher.py`, after `npm run build` in frontend/).

Starts the local server on 127.0.0.1 and shows the app in its own window:

  * "window"     — Windows & macOS: a native app window using the web engine
                   built into the OS (WebView2 on Windows, WebKit on macOS),
                   via pywebview. No browser, no terminal. Closing the window
                   quits the app.
  * "app-window" — Linux (or if the native window can't start): a standalone
                   app window from an installed Chrome / Chromium / Edge /
                   Brave (`--app` mode: no tabs, no address bar). Closing it
                   quits the app.
  * "browser"    — last resort: a normal browser tab, with a Quit button in
                   the app's sidebar.

Opening the app again while it's running brings the existing window back
instead of starting a second copy.

Environment (mostly for testing):
  AUGA_WINDOW=auto|native|app|browser|none   force a mode ("none" = no UI)
  AUGA_NO_BROWSER=1                          same as AUGA_WINDOW=none
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from appdirs import APP_NAME, DATA_DIR, FROZEN  # noqa: E402

PREFERRED_PORT = 8756
WINDOW_SIZE = (1280, 820)
MIN_WINDOW_SIZE = (960, 620)


# ---------------------------------------------------------------- utilities

def _route_output_to_log(log_path: Path) -> None:
    """A windowed (no-console) Windows app starts with sys.stdout and
    sys.stderr set to None. Anything that writes to them — uvicorn's logging
    included — then crashes the app at startup. Point them at the log file."""
    if sys.stdout is None or sys.stderr is None:
        stream = open(log_path, "a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = stream
        if sys.stderr is None:
            sys.stderr = stream


def _running_instance_url() -> str | None:
    """If AUGA-Builder is already running on the usual port, return its URL."""
    url = f"http://127.0.0.1:{PREFERRED_PORT}/"
    try:
        with urllib.request.urlopen(url + "api/health", timeout=1.5) as resp:
            if json.load(resp).get("app") == APP_NAME:
                return url
    except Exception:
        pass
    return None


def _pick_port() -> int:
    """Prefer a fixed port (nicer, memorable), fall back to any free one."""
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if sys.platform != "win32":
                # Right after a quit, the old connections linger in TIME_WAIT
                # for up to a minute. uvicorn binds with SO_REUSEADDR, so this
                # probe must too, or a quick reopen lands on a random port.
                # (On Windows SO_REUSEADDR means something riskier, and the
                # TIME_WAIT problem doesn't block binding there anyway.)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    return PREFERRED_PORT


def _requested_mode() -> str:
    if os.environ.get("AUGA_NO_BROWSER") == "1":
        return "none"
    mode = os.environ.get("AUGA_WINDOW", "auto").strip().lower()
    return mode if mode in {"auto", "native", "app", "browser", "none"} else "auto"


def _active_run_count() -> int:
    from process_manager import manager

    return sum(1 for r in manager.runs.values() if r.status in ("running", "awaiting_input"))


# ------------------------------------------------------------------ server

class Server:
    """uvicorn in a background thread, so the main thread is free for the
    window (macOS requires GUI code on the main thread)."""

    def __init__(self, app_module, port: int) -> None:
        import uvicorn

        config = uvicorn.Config(
            app_module.app,
            host="127.0.0.1",
            port=port,
            # Pin pure-Python implementations rather than "auto": uvicorn picks
            # between these with a dynamic import a frozen build can't see
            # coming, and it avoids bundling uvloop/httptools C-extensions
            # (uvloop doesn't exist on Windows, so this keeps behavior
            # identical on every OS).
            loop="asyncio",
            http="h11",
            ws="websockets",
            lifespan="on",
            # Log through our own file logging, not uvicorn's console
            # handlers (there's no console in the packaged app).
            log_config=None,
            log_level="warning",
            # Open windows keep WebSockets alive; don't wait on them forever.
            timeout_graceful_shutdown=3,
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._run, name="server", daemon=True)
        self.crashed = False

    def _run(self) -> None:
        try:
            self._server.run()
        except BaseException:
            logging.exception("Server crashed")
            self.crashed = True

    def start(self) -> bool:
        self._thread.start()
        deadline = time.time() + 30
        while time.time() < deadline:
            if self._server.started:
                return True
            if not self._thread.is_alive():
                return False
            time.sleep(0.05)
        return False

    def wait(self) -> None:
        self._thread.join()

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=8)


# -------------------------------------------------------------- UI: native

def _run_native_window(url: str, app_module) -> None:
    """Blocks until the window is closed. Raises if no native window can be
    created on this machine (caller then falls back to another mode)."""
    import webview

    state = {"closing_for_real": False}
    window = webview.create_window(
        APP_NAME,
        url,
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
        min_size=MIN_WINDOW_SIZE,
        text_select=True,
    )

    def on_closing():
        if state["closing_for_real"]:
            return True
        if _active_run_count():
            # Scripts are still running: let the app's own UI ask first.
            # (A native dialog can't be opened from inside this handler.)
            threading.Thread(
                target=lambda: window.evaluate_js(
                    "window.__augaConfirmQuit && window.__augaConfirmQuit()"
                ),
                daemon=True,
            ).start()
            return False
        return True

    def close_for_real():
        state["closing_for_real"] = True
        window.destroy()

    def bring_to_front():
        window.restore()
        window.show()
        window.on_top = True  # nudge the OS to raise it above other windows
        window.on_top = False

    def pick(kind: str):
        """Native Finder / Explorer picker for "Add scripts"."""
        if kind == "folder":
            result = window.create_file_dialog(webview.FileDialog.FOLDER)
        else:
            result = window.create_file_dialog(
                webview.FileDialog.OPEN,
                allow_multiple=False,
                file_types=("Zip archive or Python script (*.zip;*.py)",),
            )
        return result[0] if result else None

    window.events.closing += on_closing
    app_module.request_shutdown = close_for_real
    app_module.request_focus = bring_to_front
    app_module.request_pick = pick
    app_module.ui_mode = "window"

    storage = DATA_DIR / "window-storage"
    storage.mkdir(parents=True, exist_ok=True)
    webview.start(
        gui="edgechromium" if sys.platform == "win32" else None,
        private_mode=False,  # keep settings like the light/dark theme
        storage_path=str(storage),
    )


# ---------------------------------------------------------- UI: app window

def _find_chromium() -> str | None:
    """An installed Chromium-family browser that supports --app windows."""
    names = [
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
        "microsoft-edge", "microsoft-edge-stable", "brave-browser", "brave",
    ]
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    candidates: list[str] = []
    if sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    elif sys.platform == "win32":
        for base in filter(None, [os.environ.get("ProgramFiles(x86)"),
                                  os.environ.get("ProgramFiles"),
                                  os.environ.get("LOCALAPPDATA")]):
            candidates += [
                os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
            ]
    return next((c for c in candidates if os.path.exists(c)), None)


def _run_app_window(url: str, app_module) -> bool:
    """Chromium `--app` window with its own profile, so it is a separate
    process we can wait on: when the user closes it, the app quits.
    Returns False if no such browser is available or it failed to start."""
    browser = _find_chromium()
    if not browser:
        return False
    profile = DATA_DIR / "app-window"
    profile.mkdir(parents=True, exist_ok=True)
    cmd = [
        browser,
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--window-size={WINDOW_SIZE[0]},{WINDOW_SIZE[1]}",
        f"--class={APP_NAME}",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
    ]
    started = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    we_closed_it = threading.Event()

    def close_app_window():
        # Chrome treats the first SIGTERM as "please close" (which can stall),
        # and a second one as "exit now"; a hard kill is the last resort.
        we_closed_it.set()
        logging.info("Closing app window (pid %s)", proc.pid)
        for send, grace in ((proc.terminate, 3), (proc.terminate, 3), (proc.kill, 3)):
            if proc.poll() is not None:
                return
            send()
            try:
                proc.wait(timeout=grace)
                return
            except subprocess.TimeoutExpired:
                logging.info("App window still open; asking harder")

    app_module.request_shutdown = close_app_window
    # Running the same command again opens/raises a window in that process.
    app_module.request_focus = lambda: subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    app_module.ui_mode = "app-window"
    logging.info("Opened app window with %s", browser)

    code = proc.wait()
    # A browser that dies right away (and not because we closed it) couldn't
    # start: fall back to a normal browser tab instead of quitting the app.
    if not we_closed_it.is_set() and time.time() - started < 4 and code != 0:
        logging.warning("App window exited immediately (code %s); falling back", code)
        app_module.request_shutdown = app_module.request_focus = None
        return False
    return True


# -------------------------------------------------------------------- main

def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DATA_DIR / "launcher.log"
    _route_output_to_log(log_path)
    logging.basicConfig(
        filename=str(log_path),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    sys.excepthook = lambda *exc: logging.critical("Unhandled error", exc_info=exc)
    mode = _requested_mode()
    logging.info("%s starting (frozen=%s, python=%s, mode=%s)",
                 APP_NAME, FROZEN, sys.version.split()[0], mode)

    existing = _running_instance_url()
    if existing:
        logging.info("Already running at %s; bringing it to the front", existing)
        try:
            req = urllib.request.Request(existing + "api/focus", method="POST")
            urllib.request.urlopen(req, timeout=5).close()
        except Exception:
            if mode != "none":
                webbrowser.open(existing)
        return

    import main as app_module  # direct (static) import so PyInstaller bundles
    # main.py and everything it imports automatically — a string-based
    # "main:app" target would be resolved dynamically at runtime and could be
    # missed by PyInstaller's dependency analysis.

    app_module.launched_as_app = True
    server = Server(app_module, _pick_port())
    if not server.start():
        logging.error("Server failed to start")
        os._exit(1)
    url = f"http://127.0.0.1:{server._server.config.port}/"
    logging.info("Serving on %s", url)

    exit_code = 0
    try:
        shown = False
        if mode in ("auto", "native") and sys.platform in ("darwin", "win32"):
            try:
                _run_native_window(url, app_module)
                shown = True
            except Exception:
                logging.exception("Native window unavailable; trying another way")
        if not shown and mode in ("auto", "native", "app"):
            shown = _run_app_window(url, app_module)
        if not shown:
            # Browser tab (or no UI at all): the server keeps running until
            # the Quit button (or /api/shutdown) stops it.
            app_module.ui_mode = "none" if mode == "none" else "browser"
            app_module.request_shutdown = server.stop
            app_module.request_focus = (lambda: None) if mode == "none" else (lambda: webbrowser.open(url))
            if mode != "none":
                webbrowser.open(url)
            server.wait()
    except BaseException:
        logging.exception("App crashed")
        exit_code = 1
    finally:
        # Window closed (or Quit): stop scripts and the server, then exit.
        try:
            from process_manager import manager

            manager.kill_all()
        except Exception:
            pass
        server.stop()
        if server.crashed:
            exit_code = 1
        logging.info("%s stopped", APP_NAME)
        logging.shutdown()
        # Background reader threads/child pipes must not keep the app alive.
        os._exit(exit_code)


if __name__ == "__main__":
    main()
