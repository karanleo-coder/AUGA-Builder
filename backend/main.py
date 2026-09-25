from __future__ import annotations

import asyncio
import json
import re
import shutil
import sys
import time
import uuid

from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

import importer
from appdirs import FILES_DIR, FRONTEND_DIST, PACKAGES_DIR, SCRIPTS_DIR
from models import InputPayload, RunDetail, RunSummary, ScriptCreate, ScriptInfo, ScriptUpdate
from process_manager import manager, pip_install_command
from registry import registry

class _LazyModule:
    """Imports a module on first use. The Data Editor pulls in pandas and
    pyarrow, which take a moment to load, so the app starts without them."""

    def __init__(self, name: str) -> None:
        self._name, self._module = name, None

    def __getattr__(self, attr: str):
        if self._module is None:
            import importlib

            self._module = importlib.import_module(self._name)
        return getattr(self._module, attr)


data_editor = _LazyModule("data_editor")
data_clean = _LazyModule("data_clean")

app = FastAPI(title="AUGA-Builder API")
importer.cleanup_stale_staging()  # half-finished uploads from a previous run

# ---------------- Local-only guard ----------------
# This server can run scripts and install packages, so only the app's own
# page may use it. Browsers let any website send requests (and open
# WebSockets) to 127.0.0.1; they always label them with an Origin header,
# so anything from a non-local origin is refused. Checking Host as well
# stops DNS-rebinding tricks (evil.example resolving to 127.0.0.1).

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _hostname(value: str) -> str:
    try:
        return (urlsplit(value if "//" in value else "//" + value).hostname or "").lower()
    except ValueError:
        return ""


class LocalOnlyMiddleware:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
            host_ok = _hostname(headers.get("host", "")) in _LOCAL_HOSTS
            origin = headers.get("origin")
            origin_ok = origin is None or _hostname(origin) in _LOCAL_HOSTS
            cross_site = headers.get("sec-fetch-site") == "cross-site"
            if not (host_ok and origin_ok) or cross_site:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await JSONResponse({"detail": "forbidden"}, status_code=403)(scope, receive, send)
                return
        await self.inner(scope, receive, send)


app.add_middleware(LocalOnlyMiddleware)


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


# ---------------- Adding scripts from a folder / .zip ----------------

def _start_requirements_install(result: importer.ImportResult):
    if result.requirements is None:
        return None
    info = ScriptInfo(
        id="__packages__",
        name=f"Install requirements for {result.folder.name}",
        description="",
        path=str(result.requirements),
        folder="packages",
        icon="package",
        color="amber",
        created_at=time.time(),
    )
    cmd = pip_install_command(["-r", str(result.requirements)])
    return manager.start_run(info, command=cmd, cwd=result.folder).summary()


async def _run_import(fn, *args, **kwargs) -> dict:
    """Run a (blocking) import and turn the outcome into a response."""
    try:
        result = await run_in_threadpool(fn, *args, **kwargs)
    except importer.ImportConflict as e:
        return JSONResponse(
            {"detail": f'A folder named "{e.name}" is already in your scripts.', "conflict": e.name},
            status_code=409,
        )
    except importer.ImportError_ as e:
        raise HTTPException(400, str(e))
    install = _start_requirements_install(result)
    return {
        "folder": str(result.folder),
        "scripts": [s.model_dump() for s in result.scripts],
        "requirements_run": install.model_dump() if install else None,
    }


@app.post("/api/import/pick")
async def import_pick(payload: dict):
    """App window only: open the OS's own folder / file picker."""
    if request_pick is None:
        raise HTTPException(400, "native file dialogs aren't available here")
    kind = payload.get("kind")
    if kind not in ("folder", "file"):
        raise HTTPException(400, "kind must be 'folder' or 'file'")
    picked = await run_in_threadpool(request_pick, kind)
    if not picked:
        return {"cancelled": True}
    response = await _run_import(importer.import_path, Path(picked))
    if isinstance(response, JSONResponse) and response.status_code == 409:
        body = json.loads(response.body)
        body["path"] = picked  # so the page can retry with replace=true
        return JSONResponse(body, status_code=409)
    return response


@app.post("/api/pick-path")
async def pick_path(payload: dict):
    """Browse button on a script's file question: the OS's own picker."""
    if request_dialog is None:
        raise HTTPException(400, "native file dialogs aren't available here")
    kind = payload.get("kind") if payload.get("kind") in ("open", "save", "folder") else "open"
    extensions = [str(e) for e in (payload.get("extensions") or [])][:20]
    picked = await run_in_threadpool(request_dialog, kind, extensions, payload.get("default_name"))
    return {"path": picked} if picked else {"cancelled": True}


# ---------------- Data Editor (spreadsheet for Parquet/Arrow/JSON/JSONL/CSV) ----------------

def _editor_call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except data_editor.EditorError as e:
        raise HTTPException(400, str(e))


@app.get("/api/data/formats")
def data_formats():
    return {
        "formats": [{"id": k, "label": v["label"], "ext": v["ext"]} for k, v in data_editor.FORMATS.items()],
        "kinds": [{"id": k, "label": v} for k, v in data_editor.KINDS.items() if k != "other"],
        "files_dir": str(FILES_DIR),
    }


@app.get("/api/data/recent")
def data_recent():
    return data_editor.recent_files()


@app.post("/api/data/open")
def data_open(payload: dict):
    """Open by path, or (app window) with the OS's own file picker."""
    path = payload.get("path")
    if not path:
        if request_dialog is None:
            raise HTTPException(400, "choose a file to upload instead")
        path = request_dialog("open", data_editor.all_extensions(), None)
        if not path:
            return {"cancelled": True}
    return _editor_call(data_editor.editor.open_path, Path(path)).meta()


@app.put("/api/data/upload")
async def data_upload(name: str, request: Request):
    """Browser mode: the page uploads the file's bytes; it's opened as a copy."""
    safe = importer.safe_folder_name(Path(name).stem) + Path(name).suffix.lower()
    tmp_dir = importer.STAGING_DIR / f"editor-{uuid.uuid4().hex}"
    tmp_dir.mkdir(parents=True)
    tmp = tmp_dir / safe
    try:
        with open(tmp, "wb") as out:
            async for chunk in request.stream():
                out.write(chunk)
        session = await run_in_threadpool(
            _editor_call, data_editor.editor.open_path, tmp, source_name=Path(name).name, keep_path=False)
        return session.meta()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.post("/api/data/new")
def data_new(payload: dict):
    return _editor_call(data_editor.editor.new, payload.get("columns") or [], payload.get("format", "parquet")).meta()


@app.get("/api/data/{sid}")
def data_meta(sid: str):
    return _editor_call(data_editor.editor.get, sid).meta()


@app.get("/api/data/{sid}/rows")
def data_rows(sid: str, offset: int = 0, limit: int = 200):
    s = _editor_call(data_editor.editor.get, sid)
    limit = max(1, min(limit, 1000))
    return {"offset": offset, "rows": s.rows(max(0, offset), limit), "total_rows": len(s.df)}


@app.post("/api/data/{sid}/edit")
def data_edit(sid: str, payload: dict):
    s = _editor_call(data_editor.editor.get, sid)
    op = payload.get("op")
    result: dict = {}
    with s.lock:
        try:
            if op == "set":  # one or many cells (a paste): {"cells": [[row, col, "text"], ...]}
                cells = [(int(r), int(c), v) for r, c, v in payload.get("cells", [])]
                grow = max((r for r, _, _ in cells), default=-1) + 1 - len(s.df)
                if grow > 0 and payload.get("grow"):  # pasting past the last row adds rows
                    s.insert_rows(len(s.df), grow)
                cells = [(r, c, v) for r, c, v in cells if 0 <= r < len(s.df) and 0 <= c < len(s.columns)]
                changed, errors = s.set_cells(cells)
                result = {"changed": changed, "errors": errors[:20], "error_count": len(errors),
                          "rows": {str(r): s.rows(r, 1)[0] for r in sorted({r for r, _, _ in cells})[:500]}}
            elif op == "insert_rows":
                s.insert_rows(int(payload.get("at", len(s.df))), int(payload.get("count", 1)))
            elif op == "delete_rows":
                s.delete_rows([int(r) for r in payload.get("rows", [])])
            elif op == "add_column":
                s.add_column(str(payload.get("name", "")), str(payload.get("kind", "text")), payload.get("at"))
            elif op == "rename_column":
                s.rename_column(int(payload["col"]), str(payload.get("name", "")))
            elif op == "delete_column":
                s.delete_column(int(payload["col"]))
            elif op == "change_kind":
                result = {"failed": s.change_kind(int(payload["col"]), str(payload["kind"]),
                                                  bool(payload.get("dry_run")))}
            elif op == "sort":
                s.sort(int(payload["col"]), bool(payload.get("ascending", True)))
            elif op == "replace_text":  # Clean data > Find by keyword: replace or empty the found text
                changed, errors = data_clean.replace_text(s, payload.get("selection") or {}, payload.get("replacement"))
                result = {"changed": changed, "errors": errors[:20], "error_count": len(errors)}
            elif op == "remove_found":  # Clean data: remove the ticked rows of a search
                result = {"removed": data_clean.remove_rows(s, payload.get("selection") or {})}
            elif op == "undo":
                s.undo_last()
            else:
                raise HTTPException(400, "unknown edit")
        except data_editor.EditorError as e:
            raise HTTPException(400, str(e))
        except (KeyError, ValueError, TypeError):
            raise HTTPException(400, "bad edit request")
    return {"meta": s.meta(), **result}


@app.post("/api/data/{sid}/clean")
def data_clean_find(sid: str, payload: dict):
    """Clean data tools that only look: duplicate rows, rows with a keyword."""
    s = _editor_call(data_editor.editor.get, sid)
    tool = payload.get("tool")
    offset = max(0, int(payload.get("offset", 0)))
    with s.lock:
        try:
            if tool == "duplicates":
                return data_clean.find_duplicates(s, payload.get("cols"), bool(payload.get("ignore_case", True)),
                                                  offset=offset)
            if tool == "find":
                return data_clean.find_text(s, str(payload.get("text", "")), payload.get("cols"),
                                            str(payload.get("match", "contains")),
                                            bool(payload.get("case_sensitive")), offset=offset)
        except data_editor.EditorError as e:
            raise HTTPException(400, str(e))
        except (KeyError, ValueError, TypeError):
            raise HTTPException(400, "bad request")
    raise HTTPException(400, "unknown tool")


@app.post("/api/data/{sid}/save")
def data_save(sid: str, payload: dict):
    """Save in the chosen format. "pick": choose where (native Save dialog in
    the app window); "filename": browser mode's Save as (into FILES_DIR)."""
    s = _editor_call(data_editor.editor.get, sid)
    fmt = payload.get("format") or s.format
    if fmt not in data_editor.FORMATS:
        raise HTTPException(400, "unknown format")
    path: Optional[Path] = Path(payload["path"]) if payload.get("path") else None
    if payload.get("filename"):
        path = FILES_DIR / importer.safe_folder_name(Path(str(payload["filename"])).name)
    elif payload.get("pick"):
        if request_dialog is None:
            raise HTTPException(400, "type a file name instead")
        ext = data_editor.FORMATS[fmt]["ext"]
        base = (s.path.stem if s.path else Path(s.source_name or "untitled").stem) + ext
        picked = request_dialog("save", [ext], base)
        if not picked:
            return {"cancelled": True}
        path, payload["overwrite"] = Path(picked), True  # the OS dialog already asked
    try:
        s = data_editor.editor.save(sid, fmt, path, bool(payload.get("overwrite")))
    except FileExistsError as e:
        return JSONResponse({"detail": f"{Path(str(e)).name} already exists. Replace it?",
                             "exists": str(e)}, status_code=409)
    except data_editor.EditorError as e:
        raise HTTPException(400, str(e))
    return s.meta()


@app.delete("/api/data/{sid}")
def data_close(sid: str):
    data_editor.editor.close(sid)
    return {"ok": True}


@app.post("/api/reveal")
def reveal(payload: dict):
    """Show a file in Finder / Explorer / the file manager."""
    import os
    import subprocess

    path = Path(str(payload.get("path", ""))).expanduser()
    if not path.exists():
        raise HTTPException(404, "that file doesn't exist anymore")
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(path)])
        elif sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path.parent)])
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True}


@app.post("/api/import/path")
async def import_from_path(payload: dict):
    """Import a folder/.zip/.py by path (after a native pick)."""
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(400, "path is required")
    return await _run_import(
        importer.import_path, Path(path), name=payload.get("name"), replace=bool(payload.get("replace"))
    )


@app.post("/api/import/uploads")
def import_upload_start():
    """Browser mode / drag-and-drop: files are uploaded one by one."""
    return {"id": importer.new_upload()}


@app.put("/api/import/uploads/{upload_id}")
async def import_upload_file(upload_id: str, path: str, request: Request):
    try:
        target = importer.upload_target(upload_id, path)
    except importer.ImportError_ as e:
        raise HTTPException(400, str(e))
    if target is None:
        return {"skipped": path}
    written = 0
    with open(target, "wb") as out:
        async for chunk in request.stream():
            written += len(chunk)
            if written > importer.MAX_TOTAL_BYTES:
                raise HTTPException(413, "file is too big (over 500 MB)")
            out.write(chunk)
    return {"ok": True}


@app.post("/api/import/uploads/{upload_id}/finish")
async def import_upload_finish(upload_id: str, payload: dict):
    return await _run_import(
        importer.finish_upload, upload_id, payload.get("name"), bool(payload.get("replace"))
    )


@app.delete("/api/import/uploads/{upload_id}")
def import_upload_discard(upload_id: str):
    importer.discard_upload(upload_id)
    return {"ok": True}


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
request_pick = None  # (kind) -> path | None: the OS's native folder/file picker
request_dialog = None  # (kind, extensions, default_name) -> path | None: for script questions
# Set by launcher.py before the server starts, so the page never sees a
# half-started app as "dev mode" (the window hooks above arrive a moment later).
launched_as_app = False


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
        "packaged": launched_as_app,
        "mode": ui_mode,
        "scripts_dir": str(SCRIPTS_DIR),
        "native_dialogs": request_pick is not None,
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
