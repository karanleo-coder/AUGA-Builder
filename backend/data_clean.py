"""Clean-up tools for the Data Editor: duplicate rows and keyword search.

Everything here runs on Arrow arrays (pyarrow.compute), not Python objects,
so it stays fast and light on memory for files with millions of rows.

The page is sent one page of results at a time, never the full list of
matching rows. Acting on them ("remove", "replace") sends back the same
search plus the rows the user ticked or unticked by hand; the rows are
worked out again here (`selected_rows`).
"""
from __future__ import annotations

import re
from typing import Any, Optional

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc

from data_editor import EditorError, Session, display, release_memory

# Values that hold no real data: counted as empty when judging how complete a
# row is ("N/A", "null", "-", ...), so the emptier copy is the one suggested.
PLACEHOLDERS = pa.array(["", "nan", "null", "none", "n/a", "na", "-", "--", "?", "undefined", "#n/a", "nil", "missing"])
MAX_GROUPS = 100  # groups sent per page
GROUP_ROWS = 10  # rows shown per group (the most complete first); the rest are counted
MAX_ROWS = 100
MATCHES = ("contains", "word", "exact", "starts")


def _columns(s: Session, cols: Optional[list]) -> list[int]:
    picked = sorted({int(c) for c in (cols or []) if 0 <= int(c) < len(s.columns)})
    return picked or list(range(len(s.columns)))


def _arrow(s: Session, c: int) -> pa.ChunkedArray | pa.Array:
    return pa.array(s.df.iloc[:, c], from_pandas=True)


def _as_text(s: Session, c: int) -> pa.ChunkedArray | pa.Array:
    """A column as the text the sheet shows, null where the cell is empty."""
    kind = s.columns[c].kind
    col = s.df.iloc[:, c]
    if kind == "text":
        return _arrow(s, c)
    if kind in ("integer", "decimal"):
        return pc.cast(_arrow(s, c), pa.string())
    if kind == "boolean":
        return pc.if_else(_arrow(s, c), "Yes", "No")
    if kind == "date":
        return pc.cast(pa.array(col, type=pa.date32(), from_pandas=True), pa.string())
    if kind == "datetime":
        return pc.strftime(_arrow(s, c), format="%Y-%m-%d %H:%M:%S")
    return pa.array([None if v is None else str(display(v, kind)) for v in col], pa.string())


def _np(mask) -> np.ndarray:
    return np.asarray(pc.fill_null(mask, False).to_numpy(zero_copy_only=False), dtype=bool)


def _filled(s: Session, c: int, text=None) -> np.ndarray:
    """True where a cell holds real data (not empty, and not a filler like N/A)."""
    if s.columns[c].kind != "text" and text is None:
        return _np(pc.is_valid(_arrow(s, c)))
    t = text if text is not None else _as_text(s, c)
    norm = pc.utf8_lower(pc.utf8_trim_whitespace(t))
    return _np(pc.and_(pc.is_valid(t), pc.invert(pc.is_in(norm, value_set=PLACEHOLDERS))))


def _row(s: Session, i: int) -> list:
    return s.rows(int(i), 1)[0]


# ------------------------------------------------------------- duplicates

def _duplicate_groups(s: Session, cols: Optional[list], ignore_case: bool):
    """(rows sorted by group then best-first, where each group starts, score)."""
    key_cols = _columns(s, cols)
    n = len(s.df)
    score = np.zeros(n, dtype=np.int32)
    size = np.zeros(n, dtype=np.int64)
    keys = {}
    for c in range(len(s.columns)):
        is_key = c in key_cols
        text = _as_text(s, c) if (is_key or s.columns[c].kind == "text") else None
        filled = _filled(s, c, text)
        score += filled
        if s.columns[c].kind == "text":
            size += np.asarray(pc.fill_null(pc.utf8_length(text), 0).to_numpy(zero_copy_only=False), dtype=np.int64)
        if is_key:
            k = pc.utf8_trim_whitespace(text)
            if ignore_case:
                k = pc.replace_substring_regex(pc.utf8_lower(k), r"\s+", " ")
            k = pc.if_else(pa.array(filled), k, pa.scalar(None, k.type))  # fillers match as empty
            # compare small numbers standing for each value, not the text itself
            keys[f"k{c}"] = pc.dictionary_encode(k).combine_chunks().indices if isinstance(
                k, pa.ChunkedArray) else pc.dictionary_encode(k).indices
            del k
    table = pa.table({**keys, "__i": pa.array(np.arange(n, dtype=np.int64))})
    has_value = None
    for name in keys:  # rows empty in every chosen column aren't duplicates
        v = pc.is_valid(table[name])
        has_value = v if has_value is None else pc.or_(has_value, v)
    table = table.filter(has_value)
    grouped = table.group_by(list(keys), use_threads=False).aggregate([("__i", "list")])
    lists = grouped["__i_list"]
    lens = pc.list_value_length(lists)
    lists = pc.filter(lists, pc.greater_equal(lens, 2))
    del table, grouped
    if len(lists) == 0:
        return key_cols, np.array([], dtype=np.int64), np.array([], dtype=np.int64), score
    rows = np.asarray(pc.list_flatten(lists).to_numpy(zero_copy_only=False), dtype=np.int64)
    grp = np.asarray(pc.list_parent_indices(lists).to_numpy(zero_copy_only=False), dtype=np.int64)
    # in each group: most filled cells first, then most text, then the earlier row
    order = np.lexsort((rows, -size[rows], -score[rows], grp))
    rows, grp = rows[order], grp[order]
    starts = np.flatnonzero(np.r_[True, grp[1:] != grp[:-1]])
    return key_cols, rows, starts, score


def find_duplicates(s: Session, cols: Optional[list] = None, ignore_case: bool = True,
                    offset: int = 0, limit: int = MAX_GROUPS) -> dict:
    """Groups of rows that match on `cols` (all columns when none are given).

    In each group the most complete row is kept and the others are suggested
    for removal: fewest filled cells first (empty, "N/A", "null"... count as
    missing), then least text, so the incomplete or broken copy goes.
    """
    key_cols, rows, starts, score = _duplicate_groups(s, cols, ignore_case)
    ncols = len(s.columns)
    groups = []
    if len(starts):
        ends = np.r_[starts[1:], len(rows)]
        by_first_row = np.argsort(np.minimum.reduceat(rows, starts), kind="stable")  # in sheet order
        for g in by_first_row[offset:offset + limit]:
            members = rows[starts[g]:ends[g]]
            groups.append({"size": int(len(members)),
                           "rows": [{"i": int(i), "values": _row(s, i), "filled": int(score[i]), "of": ncols,
                                     "keep": k == 0} for k, i in enumerate(members[:GROUP_ROWS])]})
    result = {
        "columns": key_cols,
        "total_groups": int(len(starts)),
        "suggested_count": int(len(rows) - len(starts)),
        "offset": offset,
        "groups": groups,
    }
    del rows, starts, score
    release_memory()
    return result


# ---------------------------------------------------------- keyword search

def _re2_escape(text: str) -> str:
    return "".join("\\" + ch if (ch.isascii() and not ch.isalnum() and ch not in " _") else ch for ch in text)


def _pattern(text: str, match: str, case_sensitive: bool) -> str:
    if not text:
        raise EditorError("Type something to search for.")
    if match not in MATCHES:
        raise EditorError("Unknown kind of match.")
    body = _re2_escape(text)
    body = {
        "contains": body,
        "word": rf"(^|[^\w]){body}($|[^\w])",
        "exact": rf"^\s*{body}\s*$",
        "starts": rf"^\s*{body}",
    }[match]
    return body if case_sensitive else "(?i)" + body


def _match_masks(s: Session, text: str, cols: Optional[list], match: str, case_sensitive: bool):
    pattern = _pattern(text, match, case_sensitive)
    search_cols = _columns(s, cols)
    masks, texts = {}, {}
    for c in search_cols:
        t = _as_text(s, c)
        texts[c] = t
        masks[c] = _np(pc.match_substring_regex(t, pattern))
    return pattern, search_cols, masks, texts


def find_text(s: Session, text: str, cols: Optional[list] = None, match: str = "contains",
              case_sensitive: bool = False, offset: int = 0, limit: int = MAX_ROWS) -> dict:
    """Rows where `text` appears in any of `cols` (every column when none are given)."""
    _, search_cols, masks, _texts = _match_masks(s, text, cols, match, case_sensitive)
    n = len(s.df)
    hit = np.zeros(n, dtype=bool)
    cells = 0
    for m in masks.values():
        hit |= m
        cells += int(m.sum())
    found = np.flatnonzero(hit)
    page = found[offset:offset + limit]
    result = {
        "columns": search_cols,
        "total_rows": int(len(found)),
        "total_cells": cells,
        "offset": offset,
        "rows": [{"i": int(i), "values": _row(s, i), "matched": [c for c in search_cols if masks[c][i]]}
                 for i in page],
    }
    del masks, _texts, hit, found
    release_memory()
    return result


# ---------------------------------------------------------- acting on results

def selected_rows(s: Session, sel: dict) -> list[int]:
    """The rows a Clean data action applies to.

    `sel` = the search ("tool" plus its options), "base" ("suggested" or
    "all": every row the search suggests / finds; "none": nothing), then the
    rows ticked ("add") or unticked ("skip") by hand.
    """
    tool, base = sel.get("tool"), sel.get("base", "none")
    rows: set[int] = set()
    if base != "none":
        if tool == "duplicates":
            _, found, starts, _ = _duplicate_groups(s, sel.get("cols"), bool(sel.get("ignore_case", True)))
            first = np.zeros(len(found), dtype=bool)
            first[starts] = True
            rows = set(found[~first].tolist()) if base == "suggested" else set(found.tolist())
        elif tool == "find":
            _, _, masks, _ = _match_masks(s, str(sel.get("text", "")), sel.get("cols"),
                                          str(sel.get("match", "contains")), bool(sel.get("case_sensitive")))
            hit = np.zeros(len(s.df), dtype=bool)
            for m in masks.values():
                hit |= m
            rows = set(np.flatnonzero(hit).tolist())
        else:
            raise EditorError("Unknown clean-up tool.")
    rows -= {int(r) for r in sel.get("skip", [])}
    rows |= {int(r) for r in sel.get("add", []) if 0 <= int(r) < len(s.df)}
    return sorted(rows)


def remove_rows(s: Session, sel: dict) -> int:
    rows = selected_rows(s, sel)
    if not rows:
        raise EditorError("Tick the rows to remove first.")
    s.delete_rows(rows)
    release_memory()
    return len(rows)


def replace_text(s: Session, sel: dict, replacement: Optional[str]) -> tuple[int, list[str]]:
    """In the selected rows, replace the found text in the matching cells
    (replacement=None empties those cells instead). One undo step."""
    text, match = str(sel.get("text", "")), str(sel.get("match", "contains"))
    pattern, search_cols, masks, texts = _match_masks(s, text, sel.get("cols"), match, bool(sel.get("case_sensitive")))
    rows = selected_rows(s, {**sel, "tool": "find"})
    chosen = np.zeros(len(s.df), dtype=bool)
    chosen[rows] = True
    if replacement is not None:
        rep = replacement.replace("\\", "\\\\")
        rep = rf"\1{rep}\2" if match == "word" else rep

    changed, errors = 0, []
    wheres = {c: masks[c] & chosen for c in search_cols if s.columns[c].kind != "other"}
    wheres = {c: w for c, w in wheres.items() if w.any()}
    # the changed columns are kept for Undo, so the whole replace is one step
    s.remember_columns(list(wheres))
    for c, where in wheres.items():
        if s.columns[c].kind == "text":
            # the whole column at once, in Arrow
            t = texts[c]
            if replacement is None:
                new = pc.if_else(pa.array(where), pa.scalar(None, t.type), t)
            else:
                swapped = pc.utf8_trim_whitespace(pc.replace_substring_regex(t, pattern, rep))
                swapped = pc.if_else(pc.equal(swapped, ""), pa.scalar(None, swapped.type), swapped)
                new = pc.if_else(pa.array(where), swapped, t)
            s.df.isetitem(c, pd.Series(pd.arrays.ArrowExtensionArray(pc.cast(new, pa.string()))))
            changed += int(where.sum())
            s.dirty = True
        else:
            # numbers, dates...: typed values, checked like any edit
            cells: list[tuple[int, int, Any]] = []
            py_pattern = pattern.removeprefix("(?i)")
            flags = re.IGNORECASE if pattern.startswith("(?i)") else 0
            py_rep = None if replacement is None else rep.replace(r"\1", r"\g<1>").replace(r"\2", r"\g<2>")
            for r in np.flatnonzero(where):
                old = str(display(s.df.iat[r, c], s.columns[c].kind))
                if replacement is None:
                    cells.append((int(r), c, None))
                else:
                    new_text = re.sub(py_pattern, py_rep, old, flags=flags).strip()
                    cells.append((int(r), c, new_text or None))
            n, errs = s.set_cells(cells)
            if n and s.undo and s.undo[-1][0] == "cells":
                s.undo.pop()  # already covered by the saved columns
            changed += n
            errors += errs
    if not changed:
        if s.undo and s.undo[-1][0] == "columns":
            s.undo.pop()  # nothing changed: nothing to undo
        if not errors:
            raise EditorError("Nothing to change in the selected rows.")
    release_memory()
    return changed, errors
