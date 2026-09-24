"""Runs scripts as a plain subprocess (stdin/stdout pipes) so any
input()-driven wizard "just works" with zero per-script configuration — no
need to know a script's prompts in advance — on Windows, macOS and Linux
alike. Output is streamed live from a background reader thread; when a
script blocks on input() the backend detects it (via a short idle timeout
after output with no trailing newline, matching how input() prints its
prompt) and the frontend shows a clean input box instead of a raw terminal.

Memory stays bounded: each run keeps only the last MAX_LOG_LINES lines, and
only the last MAX_FINISHED_RUNS completed runs are retained in memory.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from appdirs import FROZEN, bundled_python
from models import LogLine, RunDetail, RunStatus, RunSummary, ScriptInfo

MAX_LOG_LINES = 2000
MAX_FINISHED_RUNS = 50
PROMPT_IDLE_SECONDS = 0.35
READ_CHUNK = 4096

PYTHON_BIN = bundled_python() or sys.executable
SECRET_HINT = re.compile(r"password|token|secret|hidden|api[\s_-]?key", re.IGNORECASE)

_PROGRESS_PATTERNS = [
    re.compile(r"\b(\d+)\s*/\s*(\d+)\b"),
    re.compile(r"\b(\d+)\s+of\s+(\d+)\b", re.IGNORECASE),
    re.compile(r"\b(\d{1,3})\s?%"),
]


def _extract_progress(line: str) -> Optional[float]:
    for pat in _PROGRESS_PATTERNS[:2]:
        m = pat.search(line)
        if m:
            try:
                num, den = int(m.group(1)), int(m.group(2))
                if den > 0:
                    return max(0.0, min(100.0, num / den * 100))
            except (ValueError, ZeroDivisionError):
                pass
    m = _PROGRESS_PATTERNS[2].search(line)
    if m:
        try:
            return max(0.0, min(100.0, float(m.group(1))))
        except ValueError:
            pass
    return None


def _command_for(script_path: Path) -> list[str]:
    if FROZEN:
        # The bundled portable runtime has no need for -u: PYTHONUNBUFFERED
        # (set in the child's env below) already forces unbuffered stdio.
        return [PYTHON_BIN, str(script_path)]
    return [PYTHON_BIN, "-u", str(script_path)]


@dataclass
class Run:
    id: str
    script: ScriptInfo
    status: RunStatus = "running"
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    progress: Optional[float] = None
    last_line: str = ""
    awaiting_prompt: Optional[str] = None
    exit_code: Optional[int] = None

    log: deque = field(default_factory=lambda: deque(maxlen=MAX_LOG_LINES))
    subscribers: set = field(default_factory=set)
    _seq: int = 0

    process: Optional[subprocess.Popen] = None
    idle_handle: Optional[asyncio.TimerHandle] = None
    _partial: bytes = b""
    _kill_requested: bool = False

    def summary(self) -> RunSummary:
        return RunSummary(
            id=self.id,
            script_id=self.script.id,
            script_name=self.script.name,
            icon=self.script.icon,
            color=self.script.color,
            status=self.status,
            started_at=self.started_at,
            ended_at=self.ended_at,
            progress=self.progress,
            last_line=self.last_line,
            awaiting_prompt=self.awaiting_prompt,
            exit_code=self.exit_code,
        )

    def detail(self) -> RunDetail:
        return RunDetail(**self.summary().model_dump(), log=list(self.log))

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    def append_line(self, text: str, stream: str = "out") -> LogLine:
        line = LogLine(seq=self._next_seq(), ts=time.time(), text=text, stream=stream)
        self.log.append(line)
        if stream in ("out", "err") and text.strip():
            self.last_line = text.strip()
            prog = _extract_progress(text)
            if prog is not None:
                self.progress = prog
        return line

    def broadcast(self, event: dict) -> None:
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass


class ProcessManager:
    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def list_summaries(self) -> list[RunSummary]:
        return [r.summary() for r in sorted(self.runs.values(), key=lambda r: r.started_at, reverse=True)]

    def get(self, run_id: str) -> Optional[Run]:
        return self.runs.get(run_id)

    def _evict_if_needed(self) -> None:
        finished = [r for r in self.runs.values() if r.status in ("completed", "failed", "killed")]
        if len(finished) <= MAX_FINISHED_RUNS:
            return
        finished.sort(key=lambda r: r.ended_at or 0)
        for r in finished[: len(finished) - MAX_FINISHED_RUNS]:
            self.runs.pop(r.id, None)

    def start_run(self, script: ScriptInfo) -> Run:
        self._loop = asyncio.get_running_loop()

        run_id = str(uuid.uuid4())
        run = Run(id=run_id, script=script)
        self.runs[run_id] = run
        self._evict_if_needed()

        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env["FORCE_COLOR"] = "0"
        env["NO_COLOR"] = "1"

        script_path = Path(script.path)
        process = subprocess.Popen(
            _command_for(script_path),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(script_path.parent),
            env=env,
            bufsize=0,
        )
        run.process = process

        threading.Thread(target=self._reader_loop, args=(run,), daemon=True).start()
        run.append_line(f"$ starting {script.name} …", stream="system")
        run.broadcast({"type": "log", "line": run.log[-1].model_dump()})
        return run

    # ---- runs in a background thread: blocking reads only, no asyncio here ----
    def _reader_loop(self, run: Run) -> None:
        stdout = run.process.stdout
        while True:
            try:
                chunk = stdout.read(READ_CHUNK) if stdout else b""
            except (OSError, ValueError):
                chunk = b""
            loop = self._loop
            if not chunk:
                if loop and loop.is_running():
                    loop.call_soon_threadsafe(self._finalize, run)
                return
            if loop and loop.is_running():
                loop.call_soon_threadsafe(self._handle_chunk, run, chunk)

    # ---- everything below runs on the asyncio event loop thread ----

    def _handle_chunk(self, run: Run, chunk: bytes) -> None:
        loop = asyncio.get_running_loop()
        data = run._partial + chunk
        lines = data.split(b"\n")
        run._partial = lines.pop()  # last element has no trailing \n yet

        for raw in lines:
            text = raw.decode("utf-8", errors="replace").rstrip("\r")
            run.awaiting_prompt = None
            line = run.append_line(text, stream="out")
            run.broadcast({"type": "log", "line": line.model_dump()})

        if run.status == "awaiting_input":
            run.status = "running"
            run.broadcast({"type": "status", "status": run.status})

        if run.idle_handle:
            run.idle_handle.cancel()
        if run._partial:
            run.idle_handle = loop.call_later(PROMPT_IDLE_SECONDS, self._check_prompt, run)

    def _check_prompt(self, run: Run) -> None:
        if not run._partial or run.process is None or run.process.poll() is not None:
            return
        prompt_text = run._partial.decode("utf-8", errors="replace").strip()
        if prompt_text:
            run.awaiting_prompt = prompt_text
            run.status = "awaiting_input"
            line = run.append_line(prompt_text, stream="out")
            run.broadcast({"type": "prompt", "text": prompt_text, "line": line.model_dump()})
            run._partial = b""

    def send_input(self, run_id: str, text: str) -> bool:
        run = self.runs.get(run_id)
        if not run or run.process is None or run.process.stdin is None:
            return False
        if run.process.poll() is not None:
            return False
        try:
            run.process.stdin.write((text + "\n").encode("utf-8"))
            run.process.stdin.flush()
        except (OSError, ValueError):
            return False

        # Don't keep a submitted secret (password/token) sitting in the log
        # or getting broadcast to every connected client.
        was_secret = bool(run.awaiting_prompt and SECRET_HINT.search(run.awaiting_prompt))
        stored_text = "•" * min(max(len(text), 4), 12) if (was_secret and text) else text

        run.awaiting_prompt = None
        if run.status == "awaiting_input":
            run.status = "running"
        line = run.append_line(stored_text, stream="in")
        run.broadcast({"type": "input", "line": line.model_dump(), "status": run.status})
        return True

    def kill_run(self, run_id: str) -> bool:
        run = self.runs.get(run_id)
        if not run or run.process is None:
            return False
        run._kill_requested = True
        try:
            run.process.terminate()
        except Exception:
            pass
        return True

    def _finalize(self, run: Run) -> None:
        if run.idle_handle:
            run.idle_handle.cancel()
            run.idle_handle = None

        if run._partial:
            text = run._partial.decode("utf-8", errors="replace").rstrip("\r")
            if text.strip():
                line = run.append_line(text, stream="out")
                run.broadcast({"type": "log", "line": line.model_dump()})
            run._partial = b""

        exit_code: Optional[int] = None
        if run.process is not None:
            try:
                exit_code = run.process.wait(timeout=5)
            except Exception:
                exit_code = run.process.poll()

        run.ended_at = time.time()
        run.exit_code = exit_code
        if run._kill_requested:
            run.status = "killed"
            run.append_line("process stopped", stream="system")
        elif exit_code == 0:
            run.status = "completed"
            run.progress = 100.0
            run.append_line("finished successfully", stream="system")
        else:
            run.status = "failed"
            run.append_line(f"exited with code {exit_code}", stream="system")

        run.broadcast({"type": "status", "status": run.status, "exit_code": exit_code})
        run.broadcast({"type": "log", "line": run.log[-1].model_dump()})
        run.broadcast({"type": "done"})


manager = ProcessManager()
