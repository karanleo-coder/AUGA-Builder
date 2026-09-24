"""Pydantic models shared across the backend."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

RunStatus = Literal["running", "awaiting_input", "completed", "failed", "killed"]


class ScriptInfo(BaseModel):
    id: str
    name: str
    description: str = ""
    path: str  # absolute path to the .py file
    folder: str  # folder name it lives in, for grouping in the sidebar
    icon: str = "sparkles"
    color: str = "violet"
    created_at: float


class ScriptCreate(BaseModel):
    path: str
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


class ScriptUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None


class LogLine(BaseModel):
    seq: int
    ts: float
    text: str
    stream: Literal["out", "err", "system", "in"] = "out"


class RunSummary(BaseModel):
    id: str
    script_id: str
    script_name: str
    icon: str
    color: str
    status: RunStatus
    started_at: float
    ended_at: Optional[float] = None
    progress: Optional[float] = None  # 0-100, None = indeterminate
    last_line: str = ""
    awaiting_prompt: Optional[str] = None
    exit_code: Optional[int] = None


class RunDetail(RunSummary):
    log: list[LogLine] = Field(default_factory=list)


class InputPayload(BaseModel):
    text: str


class BrowseEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    is_python: bool
