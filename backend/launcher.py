"""Entry point for the packaged desktop build (and a handy way to run the
whole app — API + built frontend — as a single process in dev mode too).

Starts the API/frontend server on a local port and opens it in the default
browser. There's no separate native window: the "app" is this local server
plus your browser, which keeps the packaged build small (no Chromium/Electron
runtime to bundle) and identical in behavior across Windows, macOS and Linux.
"""
from __future__ import annotations

import logging
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from appdirs import DATA_DIR, FROZEN  # noqa: E402

PREFERRED_PORT = 8756


def _pick_port() -> int:
    """Prefer a fixed port (nicer, memorable), fall back to any free one."""
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    return PREFERRED_PORT


def _wait_then_open_browser(port: int) -> None:
    url = f"http://127.0.0.1:{port}/"
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.2)
    webbrowser.open(url)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DATA_DIR / "launcher.log"
    logging.basicConfig(
        filename=str(log_path),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logging.info("AUGA-Builder starting (frozen=%s)", FROZEN)

    import uvicorn

    import main as app_module  # direct (static) import so PyInstaller bundles
    # main.py and everything it imports automatically — a string-based
    # "main:app" target would be resolved dynamically at runtime and could be
    # missed by PyInstaller's dependency analysis.

    port = _pick_port()
    threading.Thread(target=_wait_then_open_browser, args=(port,), daemon=True).start()

    try:
        # Pin pure-Python implementations rather than "auto" — uvicorn picks
        # between these with a dynamic (string-based) import that a frozen
        # build's static analysis can't see coming, and it avoids needing to
        # bundle uvloop/httptools C-extensions (uvloop isn't available on
        # Windows anyway, so this keeps behavior identical on every OS).
        uvicorn.run(
            app_module.app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            loop="asyncio",
            http="h11",
            ws="websockets",
            lifespan="on",
        )
    except Exception:
        logging.exception("Server crashed")
        raise


if __name__ == "__main__":
    main()
