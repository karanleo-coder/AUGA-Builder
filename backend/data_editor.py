"""Data Editor: open, edit and save tabular files like a spreadsheet.

Formats: Parquet, Arrow (IPC / Feather v2), JSON (an array of objects),
JSON Lines and CSV. A file is opened into a session held here (a pandas
DataFrame plus each column's type); the page loads rows a page at a time and
sends every edit here, where it's checked against the column's type. Saving
writes the chosen format with pyarrow, so column types survive the trip,
and saving in a different format converts the file.

Column types ("kinds"): text, integer, decimal, boolean, date, datetime, and
"other" for anything nested or binary (lists, structs, maps, bytes): shown
read-only and written back unchanged.
"""
from __future__ import annotations

import datetime as dt
import gc
import json
import math
import os
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.csv as pcsv
import pyarrow.feather as feather
import pyarrow.parquet as pq

from appdirs import DATA_DIR, FILES_DIR

# One worker thread for Arrow: memory freed on other threads isn't returned
# promptly, and for editing-sized work it's just as fast (measured: ~190 MB
# less for a 2-million-row file, same speed).
pa.set_cpu_count(1)
pa.set_io_thread_count(1)

FORMATS: dict[str, dict] = {
    "parquet": {"label": "Parquet", "ext": ".parquet", "also": []},
    "arrow": {"label": "Arrow", "ext": ".arrow", "also": [".feather", ".ipc"]},
    "json": {"label": "JSON", "ext": ".json", "also": []},
    "jsonl": {"label": "JSONL", "ext": ".jsonl", "also": [".ndjson"]},
    "csv": {"label": "CSV", "ext": ".csv", "also": []},
}
KINDS = {
    "text": "Text", "integer": "Whole number", "decimal": "Decimal number",
    "boolean": "Yes / No", "date": "Date", "datetime": "Date and time", "other": "Nested (read-only)",
}
ARROW_TYPES = {
    "text": pa.string(), "integer": pa.int64(), "decimal": pa.float64(),
    "boolean": pa.bool_(), "date": pa.date32(), "datetime": pa.timestamp("us"),
}
MAX_SESSIONS = 3  # open files kept in memory (unsaved ones are always kept)
MAX_UNDO = 30
# Text and dates are kept in Arrow's compact form, not as one Python object
# per cell (several times less memory for big files); a column read from a
# file even shares the file's own Arrow memory, without a copy.
TEXT = pd.ArrowDtype(pa.string())
DATE = pd.ArrowDtype(pa.date32())
ARROW_BACKED = ("text", "date")  # columns written back a whole column at a time


def release_memory() -> None:
    """Hand memory freed by a big job (opening, saving, searching) back to the
    system, so the app doesn't keep holding it."""
    gc.collect()
    try:
        pa.default_memory_pool().release_unused()
    except Exception:  # noqa: BLE001 - best effort
        pass
    if sys.platform.startswith("linux"):
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:  # noqa: BLE001 - best effort
            pass
RECENT_FILE = DATA_DIR / "recent-files.json"


class EditorError(Exception):
    """A problem to show the user as-is."""


# ------------------------------------------------------------------ formats

def format_for_path(path: Path) -> Optional[str]:
    ext = path.suffix.lower()
    for name, f in FORMATS.items():
        if ext == f["ext"] or ext in f["also"]:
            return name
    return None


def all_extensions() -> list[str]:
    return [e for f in FORMATS.values() for e in [f["ext"], *f["also"]]]


def _records_to_table(records: Any) -> pa.Table:
    if isinstance(records, dict):
        # {"col": [..], ...} or {"data": [{...}, ...]}
        lists = [v for v in records.values() if isinstance(v, list)]
        if len(lists) == 1 and lists[0] and isinstance(lists[0][0], dict):
            records = lists[0]
        elif lists and len(lists) == len(records):
            return pa.Table.from_pydict(records)
        else:
            raise EditorError("This JSON isn't a table: expected a list of objects like "
                              '[{"name": "a", "value": 1}, ...].')
    if not isinstance(records, list) or (records and not all(isinstance(r, dict) for r in records)):
        raise EditorError("This JSON isn't a table: expected a list of objects like "
                          '[{"name": "a", "value": 1}, ...].')
    try:
        return pa.Table.from_pylist(records)
    except (pa.ArrowInvalid, pa.ArrowTypeError):
        # Mixed types in a column (e.g. 1 and "one"): keep them as text.
        df = pd.DataFrame(records)
        for col in df.columns:
            if df[col].dtype == object:
                df[col] = [None if v is None else (v if isinstance(v, str) else json.dumps(v, default=str))
                           for v in df[col]]
        return pa.Table.from_pandas(df, preserve_index=False)


def read_table(path: Path, fmt: str) -> pa.Table:
    try:
        if fmt == "parquet":
            return pq.read_table(path)
        if fmt == "arrow":
            try:
                return feather.read_table(path)
            except (pa.ArrowInvalid, OSError):
                with pa.ipc.open_stream(path) as reader:  # Arrow "stream" files
                    return reader.read_all()
        if fmt == "csv":
            return pcsv.read_csv(path)
        if fmt == "jsonl":
            # Parsed like JSON (not pyarrow's JSONL reader, which guesses
            # "2026-09-20" is a timestamp), so both follow the same rules.
            with open(path, encoding="utf-8") as f:
                return _records_to_table([json.loads(line) for line in f if line.strip()])
        if fmt == "json":
            with open(path, encoding="utf-8") as f:
                return _records_to_table(json.load(f))
    except EditorError:
        raise
    except json.JSONDecodeError as e:
        raise EditorError(f"This isn't valid JSON (line {e.lineno}: {e.msg}).")
    except Exception as e:  # noqa: BLE001 - reported to the user
        raise EditorError(f"Couldn't read {path.name} as {FORMATS[fmt]['label']}: {e}")
    raise EditorError("Unsupported format.")


def _json_default(v: Any) -> Any:
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, bytes):
        return v.hex()
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return str(v)


def write_table(table: pa.Table, path: Path, fmt: str) -> None:
    """Write atomically: to a temporary file first, then swap it in, so a
    failed save never leaves a half-written file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.saving-{uuid.uuid4().hex[:8]}")
    try:
        if fmt == "parquet":
            pq.write_table(table, tmp, compression="snappy")
        elif fmt == "arrow":
            feather.write_feather(table, tmp, compression="uncompressed")
        elif fmt == "csv":
            nested = [f.name for f in table.schema if _kind_of_arrow(f.type) == "other"]
            if nested:  # CSV can't hold nested values: write them as JSON text
                cols = {f.name: (pa.array([None if v is None else json.dumps(v, default=_json_default)
                                           for v in table.column(f.name).to_pylist()], pa.string())
                                 if f.name in nested else table.column(f.name)) for f in table.schema}
                table = pa.table(cols)
            pcsv.write_csv(table, tmp)
        elif fmt == "json":
            # written a batch of rows at a time, never the whole table as Python objects
            with open(tmp, "w", encoding="utf-8") as f:
                first = True
                f.write("[")
                for batch in table.to_batches(max_chunksize=5000):
                    for row in batch.to_pylist():
                        text = json.dumps(row, default=_json_default, ensure_ascii=False, indent=2)
                        f.write(("\n" if first else ",\n") + "\n".join("  " + line for line in text.splitlines()))
                        first = False
                f.write("]\n" if first else "\n]\n")
        elif fmt == "jsonl":
            with open(tmp, "w", encoding="utf-8") as f:
                for batch in table.to_batches(max_chunksize=5000):
                    for row in batch.to_pylist():
                        f.write(json.dumps(row, default=_json_default, ensure_ascii=False) + "\n")
        else:
            raise EditorError("Unsupported format.")
        os.replace(tmp, path)
    except EditorError:
        raise
    except Exception as e:  # noqa: BLE001 - reported to the user
        raise EditorError(f"Couldn't save as {FORMATS[fmt]['label']}: {e}")
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


# ------------------------------------------------------------------- kinds

def _kind_of_arrow(t: pa.DataType) -> str:
    if pa.types.is_dictionary(t):
        return _kind_of_arrow(t.value_type)
    if pa.types.is_boolean(t):
        return "boolean"
    if pa.types.is_integer(t):
        return "integer"
    if pa.types.is_floating(t) or pa.types.is_decimal(t):
        return "decimal"
    if pa.types.is_date(t):
        return "date"
    if pa.types.is_timestamp(t):
        return "datetime"
    if pa.types.is_string(t) or pa.types.is_large_string(t) or pa.types.is_null(t):
        return "text"
    return "other"


def _to_series(col: pa.ChunkedArray, kind: str) -> pd.Series:
    if pa.types.is_dictionary(col.type):
        col = col.cast(col.type.value_type)
    # straight from Arrow into pandas' nullable types, no Python object per value
    if kind == "integer":
        return col.cast(pa.int64()).to_pandas(types_mapper={pa.int64(): pd.Int64Dtype()}.get)
    if kind == "decimal":
        return col.cast(pa.float64()).to_pandas(types_mapper={pa.float64(): pd.Float64Dtype()}.get)
    if kind == "boolean":
        return col.to_pandas(types_mapper={pa.bool_(): pd.BooleanDtype()}.get)
    if kind == "text":
        if pa.types.is_null(col.type):
            col = pa.chunked_array([pa.nulls(len(col), pa.string())])
        if not pa.types.is_string(col.type):
            col = col.cast(pa.string())
        return pd.Series(pd.arrays.ArrowExtensionArray(col))
    if kind == "date":
        return pd.Series(pd.arrays.ArrowExtensionArray(col.cast(pa.date32())))
    if kind == "datetime":
        ts = col
        if getattr(col.type, "tz", None):  # keep the wall-clock time shown in the file's zone
            ts = col.cast(pa.timestamp(col.type.unit))
        return pd.Series(ts.to_pandas(), dtype="datetime64[ns]")
    return pd.Series(col.to_pylist(), dtype="object")  # nested values stay Python objects


_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$")


def _infer_text_kind(values: list) -> str:
    """JSON / JSONL / CSV store dates as text; recognise columns where every
    value is an ISO date (or date and time), so converting to Parquet or
    Arrow keeps them as real dates."""
    sample = [v for v in values if v is not None][:5000]
    if not sample or not all(isinstance(v, str) for v in sample):
        return "text"
    if all(_ISO_DATE.match(v) for v in sample):
        return "date"
    if all(_ISO_DATETIME.match(v) for v in sample):
        return "datetime"
    return "text"


def parse_value(raw: Any, kind: str) -> Any:
    """What the user typed -> a value of the column's type (None = empty)."""
    if raw is None:
        return None
    text = str(raw).strip()
    if text == "":
        return None
    try:
        if kind == "integer":
            number = float(text.replace(",", "").replace("_", ""))
            if not number.is_integer():
                raise ValueError
            return int(number)
        if kind == "decimal":
            return float(text.replace(",", "").replace("_", ""))
        if kind == "boolean":
            low = text.lower()
            if low in ("yes", "y", "true", "t", "1", "on"):
                return True
            if low in ("no", "n", "false", "f", "0", "off"):
                return False
            raise ValueError
        if kind == "date":
            return pd.to_datetime(text).date()
        if kind == "datetime":
            return pd.to_datetime(text).to_pydatetime()
    except (ValueError, TypeError, OverflowError):
        hint = {"integer": "a whole number", "decimal": "a number", "boolean": "yes or no",
                "date": "a date like 2026-09-26", "datetime": "a date and time like 2026-09-26 14:30"}[kind]
        raise EditorError(f'"{text}" isn\'t {hint}.')
    return text


def display(v: Any, kind: str) -> Any:
    """A cell value as JSON for the grid."""
    if v is None or v is pd.NA or v is pd.NaT:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if kind == "datetime" and hasattr(v, "isoformat"):
        return v.isoformat(sep=" ", timespec="seconds") if hasattr(v, "hour") else str(v)
    if kind == "date" and hasattr(v, "isoformat"):
        return v.isoformat()
    if kind == "other":
        return json.dumps(v, default=_json_default, ensure_ascii=False)
    if hasattr(v, "item"):  # numpy scalar
        v = v.item()
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    return v


def _empty(kind: str, n: int) -> pd.Series:
    return {
        "integer": lambda: pd.Series([pd.NA] * n, dtype="Int64"),
        "decimal": lambda: pd.Series([pd.NA] * n, dtype="Float64"),
        "boolean": lambda: pd.Series([pd.NA] * n, dtype="boolean"),
        "text": lambda: pd.Series([pd.NA] * n, dtype=TEXT),
        "date": lambda: pd.Series([pd.NA] * n, dtype=DATE),
        "datetime": lambda: pd.Series([pd.NaT] * n, dtype="datetime64[ns]"),
    }.get(kind, lambda: pd.Series([None] * n, dtype="object"))()


def _typed(values: list, kind: str) -> pd.Series:
    nullable = {"integer": "Int64", "decimal": "Float64", "boolean": "boolean", "text": TEXT, "date": DATE}
    if kind in nullable:  # built in one go (setting Arrow text a cell at a time is slow)
        return pd.Series(pd.array(values, dtype=nullable[kind]))
    s = _empty(kind, len(values))
    for i, v in enumerate(values):
        if v is not None:
            s.iat[i] = v
    return s


# ----------------------------------------------------------------- session

@dataclass
class Column:
    name: str
    kind: str
    arrow_type: Optional[pa.DataType] = None  # for "other": written back as-is


@dataclass
class Session:
    id: str
    df: pd.DataFrame
    columns: list[Column]
    format: str
    path: Optional[Path] = None
    source_name: Optional[str] = None
    dirty: bool = False
    touched: float = field(default_factory=time.time)
    undo: list = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    # -- views
    def meta(self) -> dict:
        return {
            "id": self.id,
            "path": str(self.path) if self.path else None,
            "name": self.path.name if self.path else (self.source_name or "Untitled"),
            "format": self.format,
            "file_format": format_for_path(self.path) if self.path else None,
            "dirty": self.dirty,
            "total_rows": len(self.df),
            "columns": [{"name": c.name, "kind": c.kind, "label": KINDS[c.kind],
                         "arrow_type": str(c.arrow_type) if c.arrow_type is not None else str(ARROW_TYPES[c.kind])}
                        for c in self.columns],
            "can_undo": bool(self.undo),
        }

    def rows(self, offset: int, limit: int) -> list[list]:
        part = self.df.iloc[offset:offset + limit]
        kinds = [c.kind for c in self.columns]
        return [[display(v, k) for v, k in zip(row, kinds)] for row in part.itertuples(index=False, name=None)]

    def to_arrow(self) -> pa.Table:
        arrays, fields = [], []
        for i, c in enumerate(self.columns):
            s = self.df.iloc[:, i]
            if c.kind == "other":
                t = c.arrow_type or pa.string()
                arr = pa.array(s.tolist(), type=t)
            elif c.kind == "date":
                t = ARROW_TYPES["date"]
                arr = pa.array(s, from_pandas=True).cast(t)
            elif c.kind == "datetime":
                t = ARROW_TYPES["datetime"]
                # nanosecond timestamps (common in Parquet) are kept to the microsecond
                arr = pa.array(s, from_pandas=True).cast(t, safe=False)
            else:
                t = ARROW_TYPES[c.kind]
                arr = pa.array(s, type=t, from_pandas=True)
            arrays.append(arr)
            fields.append(pa.field(c.name, t))
        return pa.Table.from_arrays(arrays, schema=pa.schema(fields))

    # -- undo
    # Each step remembers only what it changed (the old cells, the removed
    # rows, the old order, the old column...), never a copy of the whole
    # table, so Undo costs little memory even for very big files.
    def _remember(self, entry: tuple) -> None:
        self.undo.append(entry)
        del self.undo[:-MAX_UNDO]

    def remember_columns(self, indexes: list[int]) -> None:
        """Before rewriting whole columns: keep them for Undo (as one step)."""
        saved = {}
        for c in indexes:
            col = self.df.iloc[:, c]
            # Arrow columns are never changed in place, so a reference is enough
            saved[c] = (col if self.columns[c].kind in ARROW_BACKED else col.copy(),
                        Column(self.columns[c].name, self.columns[c].kind, self.columns[c].arrow_type))
        self._remember(("columns", saved))

    def undo_last(self) -> None:
        if not self.undo:
            raise EditorError("Nothing to undo.")
        entry = self.undo.pop()
        kind = entry[0]
        if kind == "cells":
            by_col: dict[int, dict[int, Any]] = {}
            for r, c, old in reversed(entry[1]):  # the earliest value wins if a cell was set twice
                by_col.setdefault(c, {})[r] = old
            for c, values in by_col.items():
                if self.columns[c].kind in ARROW_BACKED:
                    updated = self.df.iloc[:, c].copy()
                    updated.iloc[list(values)] = pd.array(list(values.values()), dtype=updated.dtype)
                    self.df.isetitem(c, updated)
                else:
                    for r, v in values.items():
                        self.df.iat[r, c] = v
        elif kind == "rows_removed":  # put the removed rows back where they were
            positions, removed = entry[1], entry[2]
            total = len(self.df) + len(removed)
            kept = np.setdiff1d(np.arange(total), positions, assume_unique=True)
            both = pd.concat([self.df, removed], ignore_index=True)
            where = np.empty(total, dtype=np.int64)
            where[np.concatenate([kept, positions])] = np.arange(total)
            self.df = both.take(where).reset_index(drop=True)
        elif kind == "rows_added":
            at, count = entry[1], entry[2]
            self.df = self.df.drop(index=self.df.index[at:at + count]).reset_index(drop=True)
        elif kind == "sorted":  # the rows were put in `order`: put them back
            self.df = self.df.take(np.argsort(entry[1], kind="stable")).reset_index(drop=True)
        elif kind == "columns":
            for c, (series, column) in entry[1].items():
                self.df.isetitem(c, series.reset_index(drop=True))
                self.columns[c] = column
            self._sync_names()
        elif kind == "column_added":
            self.df = self.df.drop(columns=self.df.columns[entry[1]])
            del self.columns[entry[1]]
            self._sync_names()
        elif kind == "column_removed":
            at, series, column = entry[1], entry[2], entry[3]
            self.df.insert(at, f"__undo_{uuid.uuid4().hex}", series.reset_index(drop=True).values)
            self.columns.insert(at, column)
            self._sync_names()
        elif kind == "renamed":
            self.columns[entry[1]].name = entry[2]
            self._sync_names()
        self.dirty = True

    # -- editing
    def _col(self, index: int) -> Column:
        if not 0 <= index < len(self.columns):
            raise EditorError("That column doesn't exist.")
        return self.columns[index]

    def _check_row(self, row: int) -> None:
        if not 0 <= row < len(self.df):
            raise EditorError("That row doesn't exist.")

    def set_cells(self, cells: list[tuple[int, int, Any]]) -> tuple[int, list[str]]:
        """Set many cells (typed text). Returns (cells set, error messages)."""
        changed, errors = [], []
        by_col: dict[int, dict[int, Any]] = {}
        for r, c, raw in cells:
            col = self._col(c)
            if col.kind == "other":
                errors.append(f'"{col.name}" holds nested values and can\'t be edited here.')
                continue
            try:
                value = parse_value(raw, col.kind)
            except EditorError as e:
                errors.append(f'Row {r + 1}, "{col.name}": {e}')
                continue
            if value is None:
                value = pd.NaT if col.kind == "datetime" else pd.NA
            by_col.setdefault(c, {})[r] = value
        for c, values in by_col.items():
            rows = list(values)
            series = self.df.iloc[:, c]
            changed.extend((r, c, series.iat[r]) for r in rows)
            kind = self.columns[c].kind
            if kind in ARROW_BACKED:
                updated = series.copy()
                updated.iloc[rows] = pd.array(list(values.values()), dtype=series.dtype)
                self.df.isetitem(c, updated)
            else:
                for r, v in values.items():
                    self.df.iat[r, c] = v
        if changed:
            self._remember(("cells", changed))
            self.dirty = True
        return len(changed), errors

    def insert_rows(self, at: int, count: int) -> None:
        at = max(0, min(at, len(self.df)))
        count = max(1, min(count, 10_000))
        blank = pd.DataFrame({i: _empty(c.kind, count) for i, c in enumerate(self.columns)})
        blank.columns = self.df.columns
        self.df = pd.concat([self.df.iloc[:at], blank, self.df.iloc[at:]], ignore_index=True)
        for i, c in enumerate(self.columns):  # concat can loosen dtypes
            if c.kind != "other":
                self.df.isetitem(i, self.df.iloc[:, i].astype(_empty(c.kind, 0).dtype))
        self._remember(("rows_added", at, count))
        self.dirty = True

    def delete_rows(self, rows: list[int]) -> None:
        rows = sorted({r for r in rows if 0 <= r < len(self.df)})
        if not rows:
            raise EditorError("Select the rows to delete first.")
        positions = np.asarray(rows, dtype=np.int64)
        removed = self.df.take(positions).reset_index(drop=True)
        self.df = self.df.drop(index=self.df.index[rows]).reset_index(drop=True)
        self._remember(("rows_removed", positions, removed))
        self.dirty = True

    def add_column(self, name: str, kind: str, at: Optional[int] = None) -> None:
        name = name.strip()
        if not name:
            raise EditorError("Give the column a name.")
        if name in [c.name for c in self.columns]:
            raise EditorError(f'There is already a column called "{name}".')
        if kind not in ARROW_TYPES:
            raise EditorError("Unknown column type.")
        at = len(self.columns) if at is None else max(0, min(at, len(self.columns)))
        self._remember(("column_added", at))
        self.df.insert(at, f"__new_{uuid.uuid4().hex}", _empty(kind, len(self.df)).values)
        self.columns.insert(at, Column(name, kind))
        self._sync_names()
        self.dirty = True

    def rename_column(self, index: int, name: str) -> None:
        name = name.strip()
        col = self._col(index)
        if not name:
            raise EditorError("Give the column a name.")
        if name != col.name and name in [c.name for c in self.columns]:
            raise EditorError(f'There is already a column called "{name}".')
        self._remember(("renamed", index, col.name))
        col.name = name
        self._sync_names()
        self.dirty = True

    def delete_column(self, index: int) -> None:
        self._col(index)
        if len(self.columns) == 1:
            raise EditorError("A table needs at least one column.")
        self._remember(("column_removed", index, self.df.iloc[:, index].copy(), self.columns[index]))
        self.df = self.df.drop(columns=self.df.columns[index])
        del self.columns[index]
        self._sync_names()
        self.dirty = True

    def change_kind(self, index: int, kind: str, dry_run: bool) -> int:
        """Convert a column. Returns how many values can't be converted (they
        become empty). With dry_run, only counts."""
        col = self._col(index)
        if kind not in ARROW_TYPES:
            raise EditorError("Unknown column type.")
        converted, failed = [], 0
        for v in self.df.iloc[:, index].tolist():
            if v is None or v is pd.NA or v is pd.NaT or (isinstance(v, float) and math.isnan(v)):
                converted.append(None)
                continue
            if col.kind == "other":
                text = json.dumps(v, default=_json_default)
            elif isinstance(v, (dt.date, dt.datetime, pd.Timestamp)):
                text = v.isoformat()
            elif isinstance(v, bool):
                text = "yes" if v else "no"
            else:
                text = str(v)
            try:
                converted.append(parse_value(text, kind))
            except EditorError:
                converted.append(None)
                failed += 1
        if not dry_run:
            self.remember_columns([index])
            self.df.isetitem(index, _typed(converted, kind).values)
            self.columns[index] = Column(col.name, kind)
            self.dirty = True
        return failed

    def sort(self, index: int, ascending: bool) -> None:
        col = self._col(index)
        s = self.df.iloc[:, index]
        key = s.astype("string") if col.kind == "other" else s
        order = key.sort_values(ascending=ascending, na_position="last", kind="stable").index.to_numpy()
        self.df = self.df.take(order).reset_index(drop=True)
        self._remember(("sorted", order))
        self.dirty = True

    def _sync_names(self) -> None:
        self.df.columns = [c.name for c in self.columns]


class Editor:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    # -- sessions
    def _add(self, s: Session) -> Session:
        with self._lock:
            self.sessions[s.id] = s
            if len(self.sessions) > MAX_SESSIONS:  # drop the least recently used saved ones
                for old in sorted(self.sessions.values(), key=lambda x: x.touched):
                    if len(self.sessions) <= MAX_SESSIONS:
                        break
                    if not old.dirty and old.id != s.id:
                        del self.sessions[old.id]
        return s

    def get(self, sid: str) -> Session:
        s = self.sessions.get(sid)
        if s is None:
            raise EditorError("That file was closed. Open it again.")
        s.touched = time.time()
        return s

    def close(self, sid: str) -> None:
        if self.sessions.pop(sid, None) is not None:
            release_memory()

    def any_dirty(self) -> list[str]:
        return [s.meta()["name"] for s in self.sessions.values() if s.dirty]

    # -- open / new
    def open_path(self, path: Path, source_name: Optional[str] = None, keep_path: bool = True) -> Session:
        path = path.expanduser()
        if not path.is_file():
            raise EditorError(f"Couldn't find {path}.")
        fmt = format_for_path(path)
        if fmt is None:
            raise EditorError(f"AUGA-Builder can't open {path.suffix or 'that kind of'} files. "
                              "Open Parquet, Arrow, JSON, JSONL or CSV.")
        table = read_table(path, fmt)
        columns, data = [], {}
        for i, f in enumerate(table.schema):
            kind = _kind_of_arrow(f.type)
            name = str(f.name) if str(f.name) not in data else f"{f.name} ({i + 1})"
            column = table.column(i)
            if kind == "text" and fmt in ("json", "jsonl", "csv"):
                sample = column.drop_null().slice(0, 5000).to_pylist() if not pa.types.is_null(f.type) else []
                inferred = _infer_text_kind(sample)
                if inferred != "text":
                    kind = inferred
                    column = pa.chunked_array([pa.array(
                        [None if v is None else parse_value(v, kind) for v in column.to_pylist()], ARROW_TYPES[kind])])
            columns.append(Column(name, kind, f.type if kind == "other" else None))
            data[name] = _to_series(column, kind)
        df = pd.DataFrame(data, copy=False) if data else pd.DataFrame()
        del table, data
        release_memory()
        s = Session(id=uuid.uuid4().hex, df=df, columns=columns, format=fmt,
                    path=path if keep_path else None, source_name=source_name or path.name)
        if keep_path:
            remember_recent(path)
        return self._add(s)

    def new(self, columns: list[dict], fmt: str) -> Session:
        cols = []
        for c in columns:
            name, kind = str(c.get("name", "")).strip(), c.get("kind", "text")
            if not name or kind not in ARROW_TYPES or name in [x.name for x in cols]:
                raise EditorError("Each column needs a unique name and a type.")
            cols.append(Column(name, kind))
        if not cols:
            raise EditorError("Add at least one column.")
        if fmt not in FORMATS:
            raise EditorError("Unknown format.")
        df = pd.DataFrame({c.name: _empty(c.kind, 0) for c in cols})
        return self._add(Session(id=uuid.uuid4().hex, df=df, columns=cols, format=fmt,
                                 source_name=f"Untitled{FORMATS[fmt]['ext']}"))

    # -- save
    def save(self, sid: str, fmt: str, path: Optional[Path], overwrite: bool) -> Session:
        s = self.get(sid)
        if fmt not in FORMATS:
            raise EditorError("Unknown format.")
        if path is None:
            if s.path is None:
                base = Path(s.source_name or "untitled").stem
                path = FILES_DIR / (base + FORMATS[fmt]["ext"])
            elif format_for_path(s.path) == fmt:
                path = s.path
            else:  # same place and name, new format's extension
                path = s.path.with_suffix(FORMATS[fmt]["ext"])
        path = path.expanduser()
        if format_for_path(path) != fmt:
            path = path.with_suffix(FORMATS[fmt]["ext"])
        if path.exists() and path != s.path and not overwrite:
            raise FileExistsError(str(path))
        with s.lock:
            write_table(s.to_arrow(), path, fmt)
            release_memory()
        s.path, s.format, s.dirty = path, fmt, False
        remember_recent(path)
        return s


# ------------------------------------------------------------- recent files

def recent_files() -> list[dict]:
    try:
        items = json.loads(RECENT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    out = []
    for p in items:
        path = Path(p)
        if path.is_file() and format_for_path(path):
            out.append({"path": str(path), "name": path.name, "format": format_for_path(path),
                        "folder": str(path.parent)})
    return out[:10]


def remember_recent(path: Path) -> None:
    try:
        items = [str(path)] + [p for p in json.loads(RECENT_FILE.read_text(encoding="utf-8"))
                               if p != str(path)] if RECENT_FILE.exists() else [str(path)]
    except (OSError, ValueError):
        items = [str(path)]
    try:
        RECENT_FILE.parent.mkdir(parents=True, exist_ok=True)
        RECENT_FILE.write_text(json.dumps(items[:20], indent=2), encoding="utf-8")
    except OSError:
        pass


editor = Editor()
