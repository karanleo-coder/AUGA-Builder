from __future__ import annotations

import asyncio
import json
import re
import sys
import time

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from appdirs import FRONTEND_DIST, PACKAGES_DIR, SCRIPTS_DIR
from models import InputPayload, RunDetail, RunSummary, ScriptCreate, ScriptInfo, ScriptUpdate
from process_manager import manager, pip_install_command
from registry import registry

app = FastAPI(title="AUGA-Builder API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------- Scripts ----------------

@app.get("/api/scripts", response_model=list[ScriptInfo])
def list_scripts():
    return registry.list()


@app.post("/api/scripts/rescan", response_model=list[ScriptInfo])
def rescan_scripts():
    return registry.rescan()


@app.get("/api/scripts/browse")
def browse(path: str = ""):
    return registry.browse(path)


@app.get("/api/scripts/{script_id}", response_model=ScriptInfo)
def get_script(script_id: str):
    info = registry.get(script_id)
    if not info:
        raise HTTPException(404, "script not found")
    return info


@app.get("/api/scripts/{script_id}/source")
def get_script_source(script_id: str):
    info = registry.get(script_id)
    if not info:
        raise HTTPException(404, "script not found")
    try:
        text = open(info.path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        raise HTTPException(500, str(e))
    return {"source": text}


@app.post("/api/scripts", response_model=ScriptInfo)
def create_script(payload: ScriptCreate):
    try:
        return registry.create(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/scripts/{script_id}", response_model=ScriptInfo)
def update_script(script_id: str, payload: ScriptUpdate):
    info = registry.update(script_id, payload)
    if not info:
        raise HTTPException(404, "script not found")
    return info


@app.delete("/api/scripts/{script_id}")
def delete_script(script_id: str):
    if not registry.delete(script_id):
        raise HTTPException(404, "script not found")
    return {"ok": True}


# ---------------- Runs ----------------

@app.get("/api/runs", response_model=list[RunSummary])
def list_runs():
    return manager.list_summaries()


@app.post("/api/runs", response_model=RunSummary)
async def start_run(payload: dict):
    script_id = payload.get("script_id")
    info = registry.get(script_id) if script_id else None
    if not info:
        raise HTTPException(404, "script not found")
    run = manager.start_run(info)
    return run.summary()


_PACKAGE_SPEC = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-\[\],<>=!~]*$")


@app.post("/api/packages", response_model=RunSummary)
async def install_packages(payload: dict):
    """Install extra Python packages for scripts ("requests", "numpy==2.1").
    Shows up as a normal run, so its output streams live in the console."""
    packages = str(payload.get("packages", "")).split()
    if not packages or not all(_PACKAGE_SPEC.match(p) for p in packages):
        raise HTTPException(400, "enter package names like: requests numpy==2.1")
    info = ScriptInfo(
        id="__packages__",
        name=f"Install {' '.join(packages)}",
        description="",
        path=str(PACKAGES_DIR / "install"),
        folder="packages",
        icon="package",
        color="amber",
        created_at=time.time(),
    )
    run = manager.start_run(info, command=pip_install_command(packages), cwd=PACKAGES_DIR)
    return run.summary()


@app.get("/api/runs/{run_id}", response_model=RunDetail)
def get_run(run_id: str):
    run = manager.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    return run.detail()


@app.post("/api/runs/{run_id}/input")
async def send_input(run_id: str, payload: InputPayload):
    ok = manager.send_input(run_id, payload.text)
    if not ok:
        raise HTTPException(400, "run is not accepting input")
    return {"ok": True}


@app.post("/api/runs/{run_id}/kill")
async def kill_run(run_id: str):
    if not manager.kill_run(run_id):
        raise HTTPException(404, "run not found")
    return {"ok": True}


@app.websocket("/api/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str):
    await websocket.accept()
    run = manager.get(run_id)
    if not run:
        await websocket.send_text(json.dumps({"type": "error", "message": "run not found"}))
        await websocket.close()
        return

    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    run.subscribers.add(queue)

    try:
        await websocket.send_text(json.dumps({"type": "snapshot", "run": run.detail().model_dump()}))
        listener_task = asyncio.create_task(_pump_incoming(websocket, run_id))
        try:
            while True:
                # Wait for the next event *or* the client going away, so a
                # closed window/tab doesn't leave this handler stuck forever
                # (which also made app shutdown wait for a timeout).
                get_task = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {get_task, listener_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if get_task not in done:
                    get_task.cancel()
                    break
                await websocket.send_text(json.dumps(get_task.result()))
        finally:
            listener_task.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        run.subscribers.discard(queue)


async def _pump_incoming(websocket: WebSocket, run_id: str) -> None:
    """Allow sending input over the same socket as {"type": "input", "text": "..."}
    in addition to the REST endpoint, so the console feels instant."""
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            try:
                if msg.get("type") == "input":
                    manager.send_input(run_id, msg.get("text", ""))
                elif msg.get("type") == "kill":
                    manager.kill_run(run_id)
            except Exception:
                # Never let a single bad message take down the connection.
                pass
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        pass


@app.get("/api/health")
def health():
    return {"ok": True, "app": "AUGA-Builder"}


# Set by launcher.py in the packaged app. They stay None in dev mode
# (start.sh / uvicorn CLI), where Ctrl+C is the way out.
request_shutdown = None  # closes the app window / stops the server
request_focus = None  # brings the app window back to the front
ui_mode = None  # "window" | "app-window" | "browser" | "none"


def _in_background(fn) -> None:
    """Window calls can block briefly; keep them off the event loop."""
    import logging
    import threading

    def run():
        try:
            fn()
        except Exception:
            logging.exception("window action %r failed", fn)

    threading.Thread(target=run, daemon=True).start()


@app.get("/api/app-info")
def app_info():
    return {
        "name": "AUGA-Builder",
        "packaged": request_shutdown is not None,
        "mode": ui_mode,
        "scripts_dir": str(SCRIPTS_DIR),
    }


@app.post("/api/open-scripts-folder")
def open_scripts_folder():
    """Show the scripts folder in Explorer / Finder / the file manager."""
    import os
    import subprocess

    SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(str(SCRIPTS_DIR))  # noqa: S606 - the user's own folder
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(SCRIPTS_DIR)])
        else:
            subprocess.Popen(["xdg-open", str(SCRIPTS_DIR)])
    except Exception as e:
        raise HTTPException(500, f"couldn't open {SCRIPTS_DIR}: {e}")
    return {"ok": True, "path": str(SCRIPTS_DIR)}


@app.post("/api/shutdown")
async def shutdown():
    """Quit: stops every running script, then closes the app."""
    if request_shutdown is None:
        raise HTTPException(400, "shutdown is only available in the packaged app")
    import logging

    logging.info("Quit requested (mode=%s)", ui_mode)
    manager.kill_all()
    # Let this response reach the page before the app goes away.
    asyncio.get_running_loop().call_later(0.5, _in_background, request_shutdown)
    return {"ok": True}


@app.post("/api/focus")
def focus():
    """Opening the app again while it runs: show the existing window."""
    if request_focus is None:
        raise HTTPException(400, "not available in dev mode")
    _in_background(request_focus)
    return {"ok": True}


# ---------------- Packaged frontend (only present in a built/packaged app —
# `npm run dev` continues to serve the frontend itself via its Vite proxy) ----

if FRONTEND_DIST.exists():
    from starlette.exceptions import HTTPException as StarletteHTTPException

    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")

    @app.exception_handler(StarletteHTTPException)
    async def spa_fallback(request: Request, exc: StarletteHTTPException):
        """Client-side routes like /scripts/<id> have no matching file on
        disk — serve index.html for those instead of a 404, same as any SPA."""
        if exc.status_code == 404 and not request.url.path.startswith("/api"):
            index = FRONTEND_DIST / "index.html"
            if index.exists():
                return FileResponse(index)
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
