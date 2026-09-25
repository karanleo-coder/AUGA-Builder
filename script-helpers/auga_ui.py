"""auga_ui: small helpers that make a script look good inside AUGA-Builder.

Copy this file (script-helpers/auga_ui.py) next to any script and
`import auga_ui as ui`. Inside the
AUGA-Builder app you get real tables, clickable choice buttons, Browse
buttons for file questions, coloured messages and an exact progress ring.
Run the same script in a normal terminal and everything falls back to plain
text and typed answers, so nothing breaks.

    ui.message("Saved!", kind="success")
    ui.table(dataframe_or_rows, title="First rows")
    choice = ui.choose("What next?", [("view", "View rows"), ("quit", "Quit")])
    path = ui.ask_path("Which file?", kind="open", extensions=[".parquet"])
    name = ui.ask("Your name", default="Karan")
    ok = ui.confirm("Delete it?")
    ui.progress(40)

How it works: inside the app (environment variable AUGA_BUILDER=1) each
helper prints one line starting with "@@auga:" followed by JSON, which the
app turns into UI instead of showing as text. Questions are still ordinary
input() calls, so answers arrive exactly as if typed.
"""
from __future__ import annotations

import json
import math
import os
from typing import Any, Iterable, Sequence

IN_APP = os.environ.get("AUGA_BUILDER") == "1"
MAX_TABLE_ROWS = 500  # per table; bigger tables are cut (use paging)


def _emit(event_type: str, /, **payload: Any) -> None:
    # positional-only, so payload fields may be called "kind" too
    print("@@auga:" + json.dumps({"type": event_type, **payload}, default=str, ensure_ascii=False), flush=True)


def _cell(value: Any) -> Any:
    """JSON-friendly cell value; missing values become None."""
    try:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
    except TypeError:
        pass
    try:
        import pandas as pd

        if value is pd.NA or value is pd.NaT:
            return None
    except Exception:
        pass
    if isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return round(value, 10)
    if hasattr(value, "item"):  # numpy scalars
        try:
            return _cell(value.item())
        except Exception:
            pass
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    return str(value)


# ---------------------------------------------------------------- output

def message(text: str, kind: str = "info") -> None:
    """kind: info | success | warning | error"""
    if IN_APP:
        _emit("message", text=text, kind=kind)
    else:
        prefix = {"success": "✔", "warning": "!", "error": "✖"}.get(kind, "•")
        print(f"{prefix} {text}")


def progress(percent: float | None) -> None:
    """Exact progress for the app's ring (0-100), or None to go back to the
    normal "working" ring once a step is done. Silent in a terminal."""
    if IN_APP:
        _emit("progress", value=None if percent is None else max(0.0, min(100.0, float(percent))))


def table(
    data: Any,
    columns: Sequence[str] | None = None,
    title: str | None = None,
    first_row_number: int = 1,
    total_rows: int | None = None,
    row_numbers: Sequence[int] | None = None,
) -> None:
    """Show a table: a pandas DataFrame, or rows (lists) with `columns`.
    Row numbers start at `first_row_number` (or are given one by one in
    `row_numbers`, e.g. for search results); `total_rows` says how many rows
    exist in all (for "rows 21-40 of 1,000")."""
    try:
        import pandas as pd
    except ImportError:  # pragma: no cover - pandas is bundled with the app
        pd = None

    if pd is not None and isinstance(data, pd.DataFrame):
        cols = [str(c) for c in data.columns]
        dtypes = [str(t) for t in data.dtypes]
        rows = data.head(MAX_TABLE_ROWS).itertuples(index=False, name=None)
        count = len(data)
    else:
        rows_list = [list(r) for r in data]
        cols = list(columns or [f"col{i + 1}" for i in range(len(rows_list[0]) if rows_list else 0)])
        dtypes = None
        rows = rows_list[:MAX_TABLE_ROWS]
        count = len(rows_list)
    rows = [[_cell(v) for v in r] for r in rows]
    numbers = list(row_numbers)[:MAX_TABLE_ROWS] if row_numbers is not None else \
        [first_row_number + i for i in range(len(rows))]

    if IN_APP:
        _emit("table", title=title, columns=cols, dtypes=dtypes, rows=rows,
              row_numbers=numbers, total_rows=total_rows if total_rows is not None else count,
              truncated=count > MAX_TABLE_ROWS)
        return

    # terminal fallback: aligned text
    if title:
        print(f"\n{title}")
    header = ["#"] + cols
    body = [[str(n)] + ["—" if v is None else str(v) for v in r] for n, r in zip(numbers, rows)]
    widths = [min(30, max(len(str(x)) for x in col)) for col in zip(header, *body)] if body else [len(h) for h in header]
    fmt = "  ".join(f"{{:<{w}.{w}}}" for w in widths)
    print(fmt.format(*header))
    print("  ".join("-" * w for w in widths))
    for r in body:
        print(fmt.format(*r))
    if not body:
        print("(no rows)")


# --------------------------------------------------------------- questions

def ask(prompt: str, default: str | None = None) -> str:
    """A text question. Empty answer returns `default` (if given)."""
    shown = f"{prompt} [{default}]: " if default not in (None, "") else f"{prompt}: "
    answer = input(shown).strip()
    return answer if answer or default is None else str(default)


def choose(prompt: str, options: Iterable[Any], default: Any = None) -> str:
    """Pick one option. `options` are values, or (value, label) pairs.
    Returns the chosen value. In the app they show as buttons."""
    opts = [(str(o[0]), str(o[1])) if isinstance(o, (tuple, list)) else (str(o), str(o)) for o in options]
    if IN_APP:
        _emit("choices", options=[{"value": v, "label": l} for v, l in opts],
              default=None if default is None else str(default))
    else:
        for i, (_, label) in enumerate(opts, 1):
            print(f"  {i}. {label}")
    while True:
        answer = ask(prompt, None if default is None else str(default))
        for i, (value, label) in enumerate(opts, 1):
            if answer in (value, str(i)) or answer.lower() == label.lower():
                return value
        message(f"Please pick one of the options (1-{len(opts)}).", "warning")
        if IN_APP:  # show the buttons again for the retry
            _emit("choices", options=[{"value": v, "label": l} for v, l in opts],
                  default=None if default is None else str(default))


def confirm(prompt: str, default: bool = False) -> bool:
    return choose(prompt, [("y", "Yes"), ("n", "No")], "y" if default else "n") == "y"


def ask_path(
    prompt: str,
    kind: str = "open",
    extensions: Sequence[str] = (),
    default: str | None = None,
) -> str:
    """Ask for a file or folder path. kind: open | save | folder.
    In the app this gets a Browse button (Finder / Explorer picker)."""
    if IN_APP:
        _emit("ask_path", kind=kind, extensions=list(extensions),
              default_name=os.path.basename(default) if default else None)
    answer = ask(prompt, default)
    return os.path.expanduser(answer.strip().strip('"').strip("'"))
