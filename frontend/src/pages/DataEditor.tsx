import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DataGrid,
  type CellKeyDownArgs,
  type CellKeyboardEvent,
  type Column,
  type ColumnWidth,
  type DataGridHandle,
  type RenderEditCellProps,
  type RowsChangeData,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { ColumnDialog, NewFileDialog, SaveAsDialog } from "../components/EditorDialogs";
import { CleanData, type CleanActions, type CleanStart } from "../components/CleanData";
import { RowPanel } from "../components/RowPanel";
import {
  dataApi,
  FileExists,
  type Cell,
  type EditorColumn,
  type EditorMeta,
  type FormatId,
  type FormatsInfo,
  type Kind,
  type RecentFile,
} from "../dataEditorApi";
import { Copy, FolderOpen, Plus, Search, SlidersHorizontal, Table2, Trash2, Upload } from "../icons";
import { useStore } from "../store";

// Row heights: taller rows wrap long text over more lines; "Full text" grows
// each row until all of its text is visible.
const ROW_MODES = {
  compact: { label: "Compact", height: 26, lines: 1 },
  normal: { label: "Normal", height: 32, lines: 1 },
  tall: { label: "Tall", height: 54, lines: 2 },
  expanded: { label: "Full text", height: 32, lines: 0 },
} as const;
type RowMode = keyof typeof ROW_MODES;
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const BASE_FONT = 13;
const LINE_HEIGHT = 1.35;
const CELL_PAD_X = 21; // 10px padding each side + the cell border
// Columns grow to fit their text up to this width (at 100% zoom); longer
// text wraps (Tall / Full text rows) or ends in "…".
const AUTO_WIDTH_MAX = 520;

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function defaultColumnWidth(c: EditorColumn): number {
  return Math.max(110, Math.min(280, Math.max(c.name.length * 8.5, c.label.length * 6.5) + 44));
}

// ---- measuring text (for column widths and Full text row heights)
let measureCtx: CanvasRenderingContext2D | null = null;
let fontFamily = "";
function measurer(px: number, weight = 400): (s: string) => number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  fontFamily ||= getComputedStyle(document.body).fontFamily;
  const ctx = measureCtx;
  if (!ctx) return (s) => s.length * px * 0.55;
  const font = `${weight} ${px}px ${fontFamily}`;
  return (s) => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };
}

function displayText(v: Cell | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "● Yes" : "● No";
  return String(v);
}

/** How many lines `text` wraps to in a box `avail` px wide (like the cell's CSS). */
function wrappedLines(text: string, avail: number, measure: (s: string) => number): number {
  if (!text) return 1;
  const space = measure(" ");
  let lines = 0;
  for (const para of text.split("\n")) {
    let cur = 0;
    for (const word of para.split(" ")) {
      const w = measure(word);
      if (w > avail) {
        // a very long word breaks anywhere
        if (cur > 0) lines++;
        lines += Math.floor(w / avail);
        cur = w % avail;
      } else if (cur === 0) cur = w;
      else if (cur + space + w <= avail) cur += space + w;
      else {
        lines++;
        cur = w;
      }
    }
    lines++;
  }
  return lines;
}

/** Width (at 100% zoom) that fits a column's header and, up to a limit, its text. */
function naturalWidths(meta: EditorMeta, rows: Row[]): number[] {
  const bold = measurer(BASE_FONT, 600);
  const small = measurer(10.5, 500);
  const plain = measurer(BASE_FONT);
  return meta.columns.map((c, j) => {
    const header = Math.max(bold(c.name), small(c.label + " ▾")) + CELL_PAD_X + 4;
    let content = 0;
    let seen = 0;
    for (const r of rows) {
      if (!r.v) continue;
      const text = displayText(r.v[j]);
      if (text) {
        for (const line of text.split("\n")) content = Math.max(content, plain(line));
        if (content >= AUTO_WIDTH_MAX) break;
      }
      if (++seen >= 2000) break;
    }
    return Math.ceil(Math.max(80, header, Math.min(AUTO_WIDTH_MAX, content + CELL_PAD_X + 2)));
  });
}
// Rows are shown a page at a time: only this many are loaded and drawn, which
// keeps the app light on slow machines even for files with millions of rows.
const PAGE_SIZES = [50, 100, 200] as const;
const ACCEPT = ".parquet,.arrow,.feather,.ipc,.json,.jsonl,.ndjson,.csv";

type Row = { i: number; v: Cell[] | null };
type Status = { text: string; tone: "ok" | "error" | "info" } | null;
type Dialog = null | { type: "new" } | { type: "saveas" } | { type: "addcol"; at: number } | { type: "rename"; col: number };

// The key that opened a cell editor (Excel: typing replaces the cell).
let pendingKey: string | null = null;

// ---- cell display and editing ---------------------------------------------------

function CellView({ value, kind }: { value: Cell | undefined; kind: Kind }) {
  if (value === null || value === undefined) return null;
  if (kind === "boolean") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: value ? "#22c55e" : "#94a3b8" }} />
        {value ? "Yes" : "No"}
      </span>
    );
  }
  if (kind === "other") return <span className="font-mono text-[12px] opacity-70">{String(value)}</span>;
  return <>{String(value)}</>;
}

function CellEditor({ row, column, onRowChange, onClose, colIndex, kind }: RenderEditCellProps<Row> & { colIndex: number; kind: Kind }) {
  // Decided once, when the editor opens: started by typing a key (that key
  // replaces the cell, like Excel) or by Enter / double-click (edit the value).
  const [start] = useState(() => {
    const current = row.v?.[colIndex];
    const key = pendingKey;
    const text = key ?? (current === null || current === undefined ? "" : String(current));
    return { fromKey: key !== null, text: kind === "datetime" && key === null ? text.replace(" ", "T").slice(0, 16) : text };
  });
  const [value, setValue] = useState<string>(start.text);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    pendingKey = null;
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (start.fromKey) el.setSelectionRange(el.value.length, el.value.length);
    else if (el.type === "text") el.select();
  }, [start]);
  const fromKey = start.fromKey;

  const change = (v: string, commit = false) => {
    setValue(v);
    const next = row.v ? [...row.v] : [];
    next[colIndex] = v;
    onRowChange({ ...row, v: next }, commit);
  };

  if (kind === "boolean") {
    return (
      <select
        autoFocus
        className="h-full w-full border-0 px-2 text-[13px] outline-none"
        style={{ background: "var(--bg-elevated)", color: "var(--text)" }}
        value={value === "true" ? "yes" : value === "false" ? "no" : value}
        onChange={(e) => change(e.target.value, true)}
        onBlur={() => onClose(true)}
      >
        <option value="">(empty)</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  return (
    <input
      ref={ref}
      aria-label={column.name as string}
      type={kind === "date" && !fromKey ? "date" : kind === "datetime" && !fromKey ? "datetime-local" : "text"}
      className="rdg-text-editor h-full w-full border-0 px-2 text-[13px] outline-none"
      style={{ background: "var(--bg-elevated)", color: "var(--text)" }}
      value={value}
      onChange={(e) => change(e.target.value)}
      onBlur={() => onClose(true)}
    />
  );
}

// ---- the page -------------------------------------------------------------------

export function DataEditor() {
  const nativeDialogs = useStore((s) => s.nativeDialogs);
  const meta = useStore((s) => s.editorFile);
  const setMeta = useStore((s) => s.setEditorFile);

  const [info, setInfo] = useState<FormatsInfo | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [format, setFormat] = useState<FormatId>(meta?.format ?? "parquet");
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [menu, setMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<number>(() => loadPref("auga.editor.zoom", 1));
  const [rowMode, setRowMode] = useState<RowMode>(() => {
    const m = loadPref<string>("auga.editor.rows", "normal");
    return m in ROW_MODES ? (m as RowMode) : "normal";
  });
  // Widths the user set (dragging a column edge, Fit, Wider...), at the
  // current zoom. Controlled here so zooming scales them too.
  const [widths, setWidths] = useState<Map<string, ColumnWidth>>(new Map());
  const [panelRow, setPanelRow] = useState<number | null>(null);
  // Each column's width that fits its text (at 100% zoom), measured when a
  // file's first rows arrive; zoom scales it, so text and columns grow together.
  const [natural, setNatural] = useState<number[] | null>(null);
  // Clean data window; "peeking" steps it aside to look at a row in the sheet.
  const [clean, setClean] = useState<CleanStart | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [toolsMenu, setToolsMenu] = useState<{ x: number; y: number } | null>(null);
  const [pageSize, setPageSize] = useState<number>(() => {
    const n = loadPref<number>("auga.editor.pageSize", 100);
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : 100;
  });
  const [page, setPage] = useState(0);
  const rowHeight = Math.round(ROW_MODES[rowMode].height * zoom);

  useEffect(() => {
    try {
      localStorage.setItem("auga.editor.zoom", JSON.stringify(zoom));
      localStorage.setItem("auga.editor.rows", JSON.stringify(rowMode));
      localStorage.setItem("auga.editor.pageSize", JSON.stringify(pageSize));
    } catch {
      /* private mode etc.: just not remembered */
    }
  }, [zoom, rowMode, pageSize]);

  const gridRef = useRef<DataGridHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(meta?.id ?? null);
  const loadSeq = useRef(0);
  // a row to bring into view once its page has loaded
  const pendingRow = useRef<number | null>(null);

  useEffect(() => {
    dataApi.formats().then(setInfo).catch(() => {});
    dataApi.recent().then(setRecent).catch(() => {});
  }, []);

  const say = useCallback((text: string, tone: "ok" | "error" | "info" = "info") => {
    setStatus({ text, tone });
  }, []);
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), status.tone === "error" ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [status]);

  // ---- rows: only the current page is loaded
  const pageStart = page * pageSize;
  const pageCount = Math.max(1, Math.ceil((meta?.total_rows ?? 0) / pageSize));

  const loadRows = useCallback(async (sid: string, start: number, size: number) => {
    const id = ++loadSeq.current;
    try {
      const res = await dataApi.rows(sid, start, size);
      if (sessionRef.current !== sid || id !== loadSeq.current) return; // a newer page was asked for
      setRows(res.rows.map((v, k) => ({ i: res.offset + k, v })));
    } catch {
      /* the file was closed; the page shows what it had */
    }
  }, []);

  // (re)load whenever the page, the page size or the file changes
  const total = meta?.total_rows ?? 0;
  useEffect(() => {
    if (!meta) return;
    const last = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page > last) {
      setPage(last);
      return;
    }
    sessionRef.current = meta.id;
    loadRows(meta.id, page * pageSize, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, page, pageSize, total, loadRows]);

  // after a page loads: scroll to the row that was asked for, or to the top
  useLayoutEffect(() => {
    const want = pendingRow.current;
    if (want !== null && rows.some((r) => r.i === want)) {
      pendingRow.current = null;
      gridRef.current?.scrollToCell({ rowIdx: want - (rows[0]?.i ?? 0), idx: 1 });
    }
  }, [rows]);

  /** Show row `i` (0-based, whole file): switch to its page and scroll to it. */
  const goToRow = useCallback(
    (i: number) => {
      pendingRow.current = i;
      const target = Math.floor(i / pageSize);
      if (target !== page) setPage(target);
      else gridRef.current?.scrollToCell({ rowIdx: i - page * pageSize, idx: 1 });
    },
    [page, pageSize],
  );

  function turnPage(p: number) {
    const next = Math.max(0, Math.min(pageCount - 1, p));
    if (next === page) return;
    setPage(next);
    gridRef.current?.element?.scrollTo({ top: 0 });
  }

  /** Fresh start for a (changed) file: reload the page being shown. */
  const resetRows = useCallback(
    (m: EditorMeta) => {
      sessionRef.current = m.id;
      loadRows(m.id, page * pageSize, pageSize);
    },
    [loadRows, page, pageSize],
  );

  // Coming back to this page with a file already open.
  useEffect(() => {
    if (meta) {
      dataApi
        .meta(meta.id)
        .then((m) => {
          setMeta(m);
          setFormat(m.format);
          resetRows(m);
        })
        .catch(() => setMeta(null)); // the app was restarted: the file isn't open anymore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyStructural = useCallback(
    (m: EditorMeta) => {
      const old = useStore.getState().editorFile;
      if (!old || old.id !== m.id) {
        setWidths(new Map());
      } else if (old.columns.length !== m.columns.length) {
        // a column was added or deleted: widths follow their column by name
        setWidths((prev) => {
          const next = new Map<string, ColumnWidth>();
          m.columns.forEach((c, j) => {
            const i = old.columns.findIndex((o) => o.name === c.name);
            const w = i >= 0 ? prev.get(`c${i}`) : undefined;
            if (w) next.set(`c${j}`, w);
          });
          return next;
        });
      }
      setMeta(m);
      setSelected(new Set());
      setPanelRow((r) => (r !== null && (r >= m.total_rows || !old || old.id !== m.id) ? null : r));
      resetRows(m);
    },
    [resetRows, setMeta],
  );

  const openMeta = useCallback(
    (m: EditorMeta) => {
      const old = useStore.getState().editorFile;
      if (old && old.id !== m.id) dataApi.close(old.id);
      setFormat(m.format);
      setPage(0);
      setRows([]);
      gridRef.current?.element?.scrollTo({ top: 0 });
      applyStructural(m);
      say(`Opened ${m.name}: ${m.total_rows.toLocaleString()} rows, ${m.columns.length} columns.`, "ok");
      dataApi.recent().then(setRecent).catch(() => {});
    },
    [applyStructural, say],
  );

  const okToDiscard = () =>
    !meta?.dirty || confirm(`${meta.name} has unsaved changes. Discard them?`);

  // ---- open / new / save
  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function openDialog() {
    if (!okToDiscard()) return;
    if (!nativeDialogs) return fileInput.current?.click();
    const res = await run("Opening…", () => dataApi.open());
    if (res && !("cancelled" in res)) openMeta(res);
  }

  async function openRecent(path: string) {
    if (!okToDiscard()) return;
    const res = await run("Opening…", () => dataApi.open(path));
    if (res && !("cancelled" in res)) openMeta(res);
  }

  async function uploadFile(file: File) {
    if (!okToDiscard()) return;
    const res = await run(`Opening ${file.name}…`, () => dataApi.upload(file));
    if (res) openMeta(res);
  }

  async function save(opts: { pick?: boolean; filename?: string; fmt?: FormatId } = {}): Promise<void> {
    if (!meta) return;
    const fmt = opts.fmt ?? format;
    if (!meta.path && !opts.pick && !opts.filename) {
      // never saved (new file, or an uploaded copy): choose where first
      return nativeDialogs ? save({ pick: true }) : setDialog({ type: "saveas" });
    }
    const attempt = (overwrite: boolean) =>
      dataApi.save(meta.id, { format: fmt, pick: opts.pick, filename: opts.filename, overwrite });
    setBusy("Saving…");
    try {
      let res;
      try {
        res = await attempt(false);
      } catch (e) {
        if (!(e instanceof FileExists) || !confirm(e.message)) throw e;
        res = await attempt(true);
      }
      if ("cancelled" in res) return;
      setMeta(res);
      setFormat(res.format);
      setDialog(null);
      say(`Saved as ${res.format.toUpperCase()}: ${res.path}`, "ok");
      dataApi.recent().then(setRecent).catch(() => {});
    } catch (e) {
      if (opts.filename) throw e; // shown inside the Save as dialog
      say(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  }

  const saveAs = () => (nativeDialogs ? save({ pick: true }) : setDialog({ type: "saveas" }));

  // ---- edits
  async function edit<T = Record<string, never>>(op: Record<string, unknown>, structural = true) {
    if (!meta) return undefined;
    const res = await run("Working…", () => dataApi.edit<T>(meta.id, op));
    if (res && structural) applyStructural(res.meta);
    return res;
  }

  async function setCells(cells: [number, number, string | null][], grow = false): Promise<string[]> {
    if (!meta) return [];
    try {
      const res = await dataApi.edit<{ changed: number; errors: string[]; error_count: number; rows: Record<string, Cell[]> }>(
        meta.id,
        { op: "set", cells, grow },
      );
      const grew = res.meta.total_rows !== meta.total_rows;
      setMeta(res.meta);
      if (grew) {
        applyStructural(res.meta); // a paste added rows
      } else {
        setRows((prev) => prev.map((r) => (res.rows[String(r.i)] ? { i: r.i, v: res.rows[String(r.i)] } : r)));
      }
      if (res.error_count) {
        say(res.errors[0] + (res.error_count > 1 ? ` (and ${res.error_count - 1} more)` : ""), "error");
      } else if (cells.length > 1 && !grow) {
        say(`Changed ${res.changed} cells.`, "ok");
      } else if (cells.length > 1) {
        say(`Pasted ${res.changed} cells.`, "ok");
      }
      return res.errors;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      say(message, "error");
      // put back what the server has
      loadRows(meta.id, pageStart, pageSize);
      return [message];
    }
  }

  // ---- view: zoom, row height, column widths
  function zoomTo(z: number) {
    const next = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    const factor = next / zoom;
    setWidths((prev) => {
      const m = new Map<string, ColumnWidth>();
      prev.forEach((w, k) => w.type === "resized" && m.set(k, { type: "resized", width: Math.round(w.width * factor) }));
      return m;
    });
    setZoom(next);
  }
  const zoomStep = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    zoomTo(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))]);
  };

  function currentWidth(j: number): number {
    return widths.get(`c${j}`)?.width ?? Math.round((natural?.[j] ?? defaultColumnWidth(meta!.columns[j])) * zoom);
  }
  function setColumnWidth(j: number, px: number) {
    setWidths((prev) => new Map(prev).set(`c${j}`, { type: "resized", width: Math.round(Math.max(56, Math.min(1200, px))) }));
  }
  function fitColumn(j: number) {
    if (!meta) return;
    const c = meta.columns[j];
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const font = getComputedStyle(document.body).fontFamily;
    ctx.font = `600 ${BASE_FONT * zoom}px ${font}`;
    let widest = ctx.measureText(c.name).width;
    ctx.font = `${10.5 * zoom}px ${font}`;
    widest = Math.max(widest, ctx.measureText(c.label + " ▾").width);
    ctx.font = `${BASE_FONT * zoom}px ${font}`;
    let seen = 0;
    for (const r of rows) {
      if (!r.v) continue;
      const v = r.v[j];
      if (v !== null && v !== undefined) widest = Math.max(widest, ctx.measureText(typeof v === "boolean" ? "● Yes" : String(v)).width);
      if (++seen > 3000) break;
    }
    setColumnWidth(j, widest + 32 * zoom);
  }

  function openClean(start: CleanStart) {
    setMenu(null);
    setToolsMenu(null);
    setPeeking(false);
    setClean(start);
  }

  const cleanActions: CleanActions = {
    removeFound: async (selection) => {
      const res = await edit<{ removed: number }>({ op: "remove_found", selection });
      if (res) say(`Removed ${res.removed.toLocaleString()} row${res.removed === 1 ? "" : "s"}. Undo brings them back.`, "ok");
      return !!res;
    },
    replaceText: async (selection, replacement) => {
      const res = await edit<{ changed: number; errors: string[]; error_count: number }>({
        op: "replace_text",
        selection,
        replacement,
      });
      if (res) say(`Changed ${res.changed.toLocaleString()} cell${res.changed === 1 ? "" : "s"}. Undo puts them back.`, "ok");
      return res;
    },
    showRow: (i) => {
      setPeeking(true);
      setSelected(new Set([i]));
      setActive((a) => ({ row: i, col: a?.col ?? 0 }));
      goToRow(i);
    },
  };

  /** Show a row in the floating row window; the sheet follows along behind it. */
  function openRow(i: number) {
    setPanelRow(i);
    setSelected(new Set([i]));
    setActive((a) => ({ row: i, col: a?.col ?? 0 }));
    goToRow(i);
  }

  function onRowsChange(newRows: Row[], data: RowsChangeData<Row>) {
    const j = Number(String(data.column.key).slice(1));
    const cells: [number, number, string | null][] = data.indexes.map((idx) => {
      const v = newRows[idx].v?.[j];
      return [newRows[idx].i, j, v === null || v === undefined ? null : String(v)];
    });
    setRows(newRows); // show the typed value right away; the server's version follows
    setCells(cells);
  }

  function pasteBlock(text: string) {
    if (!active || !meta) return;
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    const cells: [number, number, string][] = [];
    lines.forEach((line, dr) =>
      line.split("\t").forEach((value, dc) => {
        const col = active.col + dc;
        if (col < meta.columns.length) cells.push([active.row + dr, col, value]);
      }),
    );
    if (cells.length) setCells(cells, true);
  }

  async function addRow(at?: number) {
    if (!meta) return;
    const where = at ?? meta.total_rows;
    const res = await edit({ op: "insert_rows", at: where, count: 1 });
    if (res) {
      setActive((a) => ({ row: where, col: a?.col ?? 0 }));
      setSelected(new Set([where]));
      goToRow(where);
    }
  }

  async function deleteRows() {
    const targets = selected.size ? [...selected] : active ? [active.row] : [];
    if (!targets.length) return say("Click a row number (or a cell) to choose rows to delete.", "info");
    if (targets.length > 1 && !confirm(`Delete ${targets.length} rows?`)) return;
    const res = await edit({ op: "delete_rows", rows: targets });
    if (res) say(`Deleted ${targets.length} row${targets.length === 1 ? "" : "s"}.`, "ok");
  }

  async function changeKind(col: number, kind: Kind) {
    setMenu(null);
    const check = await edit<{ failed: number }>({ op: "change_kind", col, kind, dry_run: true }, false);
    if (!check) return;
    if (check.failed && !confirm(`${check.failed} value(s) can't be converted and will become empty. Continue?`)) return;
    await edit({ op: "change_kind", col, kind });
  }

  async function undo() {
    if (meta?.can_undo) await edit({ op: "undo" });
  }

  // ---- keyboard: Cmd/Ctrl+S save, Cmd/Ctrl+Z undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || dialog) return;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select");
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomStep(1);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomStep(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        zoomTo(1);
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if (e.key.toLowerCase() === "z" && !e.shiftKey && !typing) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onCellKeyDown(args: CellKeyDownArgs<Row>, event: CellKeyboardEvent) {
    if (args.mode !== "ACTIVE" || !args.column || args.column.key === "__n") return;
    const j = Number(args.column.key.slice(1));
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventGridDefault();
      if (meta?.columns[j]?.kind !== "other" && args.row) setCells([[args.row.i, j, null]]);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // The editor starts with this key; stop the browser typing it a second
      // time into the editor it's about to focus.
      pendingKey = event.key;
      event.preventDefault();
    }
  }

  // ---- columns
  const columns = useMemo<Column<Row>[]>(() => {
    if (!meta) return [];
    const numberCol: Column<Row> = {
      key: "__n",
      name: "",
      width: Math.round(64 * zoom),
      minWidth: 48,
      frozen: true,
      resizable: false,
      cellClass: "auga-rownum",
      headerCellClass: "auga-rownum",
      renderCell: ({ row }) => row.i + 1,
    };
    return [
      numberCol,
      ...meta.columns.map((c: EditorColumn, j): Column<Row> => {
        const numeric = c.kind === "integer" || c.kind === "decimal";
        return {
          key: `c${j}`,
          name: c.name,
          width: Math.round((natural?.[j] ?? defaultColumnWidth(c)) * zoom),
          resizable: true,
          editable: c.kind !== "other",
          cellClass: numeric ? "auga-num" : undefined,
          renderHeaderCell: () => (
            <button
              className="flex h-full w-full min-w-0 flex-col items-start justify-center text-left leading-tight"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ col: j, x: r.left, y: r.bottom });
              }}
              title={`${c.name} · ${c.label} (${c.arrow_type}). Click for sort, rename, type…`}
            >
              <span className="w-full truncate font-semibold">{c.name}</span>
              <span className="auga-kind w-full truncate">{c.label} ▾</span>
            </button>
          ),
          renderCell: ({ row }) =>
            row.v === null ? (
              j === 0 ? <span style={{ color: "var(--text-faint)" }}>…</span> : null
            ) : (
              <div className="auga-cell">
                <CellView value={row.v[j]} kind={c.kind} />
              </div>
            ),
          renderEditCell: (p) => <CellEditor {...p} colIndex={j} kind={c.kind} />,
          editorOptions: { displayCellContent: false },
        };
      }),
    ];
  }, [meta, zoom, natural]);

  // Measure the columns once the first rows of a file (or a changed file) are in.
  const firstRowsIn = rows.length > 0 || total === 0;
  useEffect(() => {
    if (!meta || !firstRowsIn) return;
    setNatural(naturalWidths(meta, rows));
    // widths the grid measured itself would pin the old sizes; keep only the user's
    setWidths((prev) => {
      const next = new Map<string, ColumnWidth>();
      prev.forEach((w, k) => w.type === "resized" && next.set(k, w));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, meta?.columns, firstRowsIn]);

  // Full text rows: each row as tall as its longest wrapped cell.
  const fullText = ROW_MODES[rowMode].lines === 0;
  const rowHeightFor = useMemo(() => {
    if (!fullText || !meta) return rowHeight;
    const cache = new WeakMap<Row, number>();
    const fontPx = BASE_FONT * zoom;
    const measure = measurer(fontPx);
    const lineH = fontPx * LINE_HEIGHT;
    const colW = meta.columns.map(
      (c, j) => widths.get(`c${j}`)?.width ?? Math.round((natural?.[j] ?? defaultColumnWidth(c)) * zoom),
    );
    return (row: Row) => {
      if (!row.v) return rowHeight;
      let h = cache.get(row);
      if (h === undefined) {
        let lines = 1;
        row.v.forEach((v, j) => {
          const text = displayText(v);
          if (text) lines = Math.max(lines, wrappedLines(text, Math.max(20, colW[j] - CELL_PAD_X), measure));
        });
        h = Math.max(rowHeight, Math.ceil(Math.min(lines, 60) * lineH + 12 * zoom));
        cache.set(row, h);
      }
      return h;
    };
  }, [fullText, meta, rowHeight, zoom, widths, natural]);

  const selectedColumnKind = active && meta ? meta.columns[active.col]?.kind : undefined;
  const formatLabel = (f: FormatId | null | undefined) => info?.formats.find((x) => x.id === f)?.label ?? f ?? "";
  const converting = meta && meta.file_format && format !== meta.file_format;

  // ---- render
  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) uploadFile(file);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) uploadFile(f);
        }}
      />

      {/* ---- top bar: file, format, actions ---- */}
      <div className="border-b px-5 py-3" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: "color-mix(in srgb, #22d3ee 15%, transparent)" }}
            >
              <Table2 size={18} color="#0891b2" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {meta ? meta.name : "Data Editor"}
                {meta?.dirty && <span style={{ color: "var(--accent)" }}> ●</span>}
              </p>
              <p className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
                {meta
                  ? meta.path
                    ? meta.path
                    : "Not saved yet"
                  : "Edit Parquet, Arrow, JSON, JSONL and CSV files like a spreadsheet"}
              </p>
            </div>
          </div>

          {/* format: what Save writes */}
          <div
            className="flex items-center rounded-lg border p-0.5"
            style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}
            role="radiogroup"
            aria-label="File format"
          >
            {info?.formats.map((f) => (
              <button
                key={f.id}
                role="radio"
                aria-checked={format === f.id}
                onClick={() => setFormat(f.id)}
                className="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
                style={{
                  background: format === f.id ? "var(--bg-elevated)" : "transparent",
                  color: format === f.id ? "var(--accent)" : "var(--text-muted)",
                  boxShadow: format === f.id ? "0 1px 2px rgba(0,0,0,.12)" : undefined,
                }}
                title={`Save as ${f.label} (${f.ext})`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <ToolbarButton onClick={() => okToDiscard() && setDialog({ type: "new" })}>
              <Plus size={14} /> New
            </ToolbarButton>
            <ToolbarButton onClick={openDialog}>
              <FolderOpen size={14} /> Open…
            </ToolbarButton>
            <button
              onClick={() => save()}
              disabled={!meta || !!busy}
              className="rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: "var(--accent)", color: "var(--accent-text)" }}
              title="Save (⌘S / Ctrl+S)"
            >
              {converting ? `Save as ${formatLabel(format)}` : "Save"}
            </button>
            <ToolbarButton onClick={saveAs} disabled={!meta}>
              Save as…
            </ToolbarButton>
          </div>
        </div>

        {meta && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <ToolbarButton onClick={() => addRow()}>
              <Plus size={13} /> Row
            </ToolbarButton>
            <ToolbarButton onClick={() => active && addRow(active.row + 1)} disabled={!active}>
              Insert row below
            </ToolbarButton>
            <ToolbarButton onClick={deleteRows}>
              <Trash2 size={13} /> Delete {selected.size > 1 ? `${selected.size} rows` : "row"}
            </ToolbarButton>
            <span className="mx-1 h-5 w-px" style={{ background: "var(--border)" }} />
            <ToolbarButton onClick={() => setDialog({ type: "addcol", at: meta.columns.length })}>
              <Plus size={13} /> Column
            </ToolbarButton>
            <ToolbarButton onClick={undo} disabled={!meta.can_undo} title="Undo (⌘Z / Ctrl+Z)">
              Undo
            </ToolbarButton>
            <ToolbarButton
              onClick={() => openRow(active?.row ?? [...selected][0] ?? 0)}
              disabled={!meta.total_rows}
              title="Open the selected row in a window showing all of its text (or double-click a row number)"
            >
              Expand row
            </ToolbarButton>
            <span className="mx-1 h-5 w-px" style={{ background: "var(--border)" }} />
            <Segmented
              label="Row height"
              value={rowMode}
              options={(Object.keys(ROW_MODES) as RowMode[]).map((k) => ({ id: k, label: ROW_MODES[k].label }))}
              onChange={(v) => setRowMode(v as RowMode)}
            />
            <div className="flex items-center rounded-lg border" style={{ borderColor: "var(--border)" }} aria-label="Zoom">
              <button className="px-2 py-1 text-sm hover:bg-[var(--bg-inset)]" onClick={() => zoomStep(-1)} title="Zoom out (⌘− / Ctrl+−)">
                −
              </button>
              <button
                className="min-w-[3.2rem] border-x px-1 py-1 text-xs font-semibold tabular-nums hover:bg-[var(--bg-inset)]"
                style={{ borderColor: "var(--border)" }}
                onClick={() => zoomTo(1)}
                title="Reset zoom (⌘0 / Ctrl+0)"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button className="px-2 py-1 text-sm hover:bg-[var(--bg-inset)]" onClick={() => zoomStep(1)} title="Zoom in (⌘+ / Ctrl++)">
                +
              </button>
            </div>
            {meta.path && (
              <ToolbarButton onClick={() => dataApi.reveal(meta.path!)}>Show in folder</ToolbarButton>
            )}
            <ToolbarButton
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setToolsMenu(toolsMenu ? null : { x: r.left, y: r.bottom });
              }}
              title="More tools: clean data…"
              aria-haspopup="menu"
            >
              <SlidersHorizontal size={13} /> Tools ▾
            </ToolbarButton>
          </div>
        )}

        {/* one fixed-height line, so messages coming and going never move the sheet */}
        {(meta || status || busy) && (
          <div className="mt-2 flex h-6 items-center gap-3 overflow-hidden whitespace-nowrap text-xs">
            {converting && (
              <span className="rounded-md px-2 py-1" style={{ background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}>
                This file is {formatLabel(meta!.file_format)}. Saving writes a {formatLabel(format)} copy next to it.
              </span>
            )}
            {busy && <span className="animate-pulse-soft" style={{ color: "var(--text-muted)" }}>{busy}</span>}
            {status && (
              <span
                className="min-w-0 truncate"
                title={status.text}
                style={{ color: status.tone === "error" ? "#e11d48" : status.tone === "ok" ? "#16a34a" : "var(--text-muted)" }}
              >
                {status.tone === "ok" ? "✔ " : status.tone === "error" ? "✖ " : ""}
                {status.text}
              </span>
            )}
            {meta && (
              <span className="ml-auto shrink-0 tabular-nums" style={{ color: "var(--text-faint)" }}>
                {meta.total_rows.toLocaleString()} rows · {meta.columns.length} columns
                {active && selectedColumnKind ? ` · ${meta.columns[active.col].name}: ${meta.columns[active.col].label}` : ""}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ---- the sheet ---- */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
        {meta ? (
          meta.columns.length ? (
            <DataGrid
              ref={gridRef}
              className={`auga-grid${ROW_MODES[rowMode].lines !== 1 ? " auga-wrap" : ""}${fullText ? " auga-full" : ""}`}
              columns={columns}
              rows={rows}
              rowHeight={rowHeightFor}
              headerRowHeight={Math.round(46 * zoom)}
              columnWidths={widths}
              onColumnWidthsChange={(w) => setWidths(new Map(w))}
              onCellDoubleClick={({ row, column }, e) => {
                if (column.key !== "__n") return;
                e.preventGridDefault();
                openRow(row.i);
              }}
              rowKeyGetter={(r) => r.i}
              onRowsChange={onRowsChange}
              onActivePositionChange={({ rowIdx, column }) => {
                if (column && column.key !== "__n" && rowIdx >= 0 && rows[rowIdx])
                  setActive({ row: rows[rowIdx].i, col: Number(column.key.slice(1)) });
              }}
              onCellClick={({ row, column }, e) => {
                if (column.key !== "__n") return;
                setSelected((prev) => {
                  const next = new Set(e.metaKey || e.ctrlKey ? prev : []);
                  if (e.shiftKey && active) {
                    const [a, b] = [Math.min(active.row, row.i), Math.max(active.row, row.i)];
                    for (let r = a; r <= b; r++) next.add(r);
                  } else if (next.has(row.i) && (e.metaKey || e.ctrlKey)) next.delete(row.i);
                  else next.add(row.i);
                  return next;
                });
                setActive({ row: row.i, col: active?.col ?? 0 });
              }}
              onCellKeyDown={onCellKeyDown}
              onCellCopy={({ row, column }, e) => {
                if (column.key === "__n" || !row.v) return;
                const v = row.v[Number(column.key.slice(1))];
                e.clipboardData.setData("text/plain", v === null || v === undefined ? "" : String(v));
                e.preventDefault();
              }}
              onCellPaste={({ row }, e) => {
                pasteBlock(e.clipboardData.getData("text/plain"));
                e.preventDefault();
                return row;
              }}
              rowClass={(r) => (selected.has(r.i) ? "auga-row-selected" : undefined)}
              style={
                {
                  height: "100%",
                  "--rdg-font-size": `${BASE_FONT * zoom}px`,
                  "--auga-zoom": zoom,
                  "--auga-lines": ROW_MODES[rowMode].lines || "none",
                } as React.CSSProperties
              }
            />
          ) : (
            <p className="p-8 text-sm" style={{ color: "var(--text-muted)" }}>This file has no columns.</p>
          )
        ) : (
          <EmptyState
            recent={recent}
            onOpen={openDialog}
            onNew={() => setDialog({ type: "new" })}
            onRecent={openRecent}
          />
        )}
        </div>
        {meta && meta.columns.length > 0 && (
          <Pager
            page={page}
            pageCount={pageCount}
            pageSize={pageSize}
            start={pageStart}
            shown={rows.length}
            total={meta.total_rows}
            onPage={turnPage}
            onPageSize={(n) => {
              const first = active?.row ?? pageStart; // keep the same rows in view
              setPageSize(n);
              setPage(Math.floor(first / n));
            }}
          />
        )}
        </div>
        {meta && panelRow !== null && panelRow < meta.total_rows && (
          <RowPanel
            meta={meta}
            rowIndex={panelRow}
            values={rows.find((r) => r.i === panelRow)?.v ?? null}
            widths={natural}
            onClose={() => setPanelRow(null)}
            onMove={(d) => openRow(Math.max(0, Math.min(meta.total_rows - 1, panelRow + d)))}
            onSave={(changes) => setCells(changes.map(([c, v]) => [panelRow, c, v]))}
          />
        )}
        {meta && clean && (
          <CleanData meta={meta} start={clean} hidden={peeking} actions={cleanActions} onClose={() => setClean(null)} />
        )}
        {meta && clean && peeking && (
          <button
            onClick={() => setPeeking(false)}
            className="auga-float fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-5 py-2.5 text-sm font-semibold"
            style={{ background: "var(--accent)", color: "var(--accent-text)" }}
          >
            ◂ Back to Clean data
          </button>
        )}
        {dragging && (
          <div
            className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed text-sm font-semibold"
            style={{ borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 8%, var(--bg))" }}
          >
            Drop to open the file
          </div>
        )}
      </div>

      {/* ---- tools menu: the less-used tools, kept off the main toolbar ---- */}
      {toolsMenu && meta && (
        <ToolsMenu
          x={toolsMenu.x}
          y={toolsMenu.y}
          onClose={() => setToolsMenu(null)}
          onPick={(tool) => openClean({ tool })}
        />
      )}

      {/* ---- column menu ---- */}
      {menu && meta && (
        <ColumnMenu
          x={menu.x}
          y={menu.y}
          column={meta.columns[menu.col]}
          kinds={info?.kinds ?? []}
          onClose={() => setMenu(null)}
          onSort={(asc) => {
            setMenu(null);
            edit({ op: "sort", col: menu.col, ascending: asc });
          }}
          onRename={() => {
            setMenu(null);
            setDialog({ type: "rename", col: menu.col });
          }}
          onWidth={(action) => {
            setMenu(null);
            if (action === "fit") fitColumn(menu.col);
            else if (action === "reset")
              setWidths((prev) => {
                const next = new Map(prev);
                next.delete(`c${menu.col}`);
                return next;
              });
            else setColumnWidth(menu.col, currentWidth(menu.col) * (action === "wider" ? 1.35 : 1 / 1.35));
          }}
          onInsert={(right) => {
            setMenu(null);
            setDialog({ type: "addcol", at: menu.col + (right ? 1 : 0) });
          }}
          onDelete={() => {
            setMenu(null);
            if (confirm(`Delete the "${meta.columns[menu.col].name}" column and all its values?`))
              edit({ op: "delete_column", col: menu.col });
          }}
          onKind={(k) => changeKind(menu.col, k)}
          onClean={(tool) => openClean({ tool, cols: [menu.col] })}
        />
      )}

      {/* ---- dialogs ---- */}
      {dialog?.type === "new" && info && (
        <NewFileDialog
          info={info}
          initialFormat={format}
          onClose={() => setDialog(null)}
          onCreate={async (cols, fmt) => {
            const m = await dataApi.create(cols, fmt);
            setDialog(null);
            openMeta(m);
            setFormat(fmt);
            say("New file ready. Click + Row to start adding data.", "ok");
          }}
        />
      )}
      {dialog?.type === "saveas" && info && meta && (
        <SaveAsDialog
          info={info}
          defaultName={meta.name}
          format={format}
          onClose={() => setDialog(null)}
          onSave={(filename, fmt) => save({ filename, fmt })}
        />
      )}
      {dialog?.type === "addcol" && info && (
        <ColumnDialog
          title="Add a column"
          info={info}
          askKind
          onClose={() => setDialog(null)}
          onSubmit={async (name, kind) => {
            const res = await dataApi.edit(meta!.id, { op: "add_column", name, kind, at: dialog.at });
            setDialog(null);
            applyStructural(res.meta);
          }}
        />
      )}
      {dialog?.type === "rename" && info && meta && (
        <ColumnDialog
          title="Rename column"
          info={info}
          initialName={meta.columns[dialog.col].name}
          askKind={false}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const res = await dataApi.edit(meta.id, { op: "rename_column", col: dialog.col, name });
            setDialog(null);
            applyStructural(res.meta);
          }}
        />
      )}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center rounded-lg border p-0.5" style={{ borderColor: "var(--border)" }} role="radiogroup" aria-label={label} title={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className="rounded-md px-2 py-1 text-[11px] font-medium"
          style={{
            background: value === o.id ? "var(--bg-inset)" : "transparent",
            color: value === o.id ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToolbarButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-inset)] disabled:opacity-40"
      style={{ borderColor: "var(--border)" }}
    />
  );
}

/** Page switcher under the sheet: rows are shown one page at a time. */
function Pager({
  page,
  pageCount,
  pageSize,
  start,
  shown,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  start: number;
  shown: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(page + 1));
  useEffect(() => setDraft(String(page + 1)), [page]);
  const go = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n)) onPage(n - 1);
    else setDraft(String(page + 1));
  };
  const btn =
    "flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-xs font-medium hover:bg-[var(--bg-inset)] disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 border-t px-4 text-xs"
      style={{ borderColor: "var(--border)", background: "var(--bg-elevated)", color: "var(--text-muted)" }}
    >
      <span className="tabular-nums">
        {total === 0
          ? "No rows"
          : `Rows ${(start + 1).toLocaleString()}–${(start + Math.max(shown, 1)).toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="ml-auto flex items-center gap-1" aria-label="Pages">
        <button className={btn} onClick={() => onPage(0)} disabled={page === 0} title="First page" aria-label="First page">«</button>
        <button className={btn} onClick={() => onPage(page - 1)} disabled={page === 0} aria-label="Previous page">‹ Prev</button>
        <span className="flex items-center gap-1.5 px-1">
          Page
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && go()}
            onBlur={go}
            aria-label="Page number"
            className="w-14 rounded-md border bg-transparent px-1.5 py-0.5 text-center text-xs tabular-nums outline-none focus:ring-2"
            style={{ borderColor: "var(--border)", color: "var(--text)" }}
          />
          of {pageCount.toLocaleString()}
        </span>
        <button className={btn} onClick={() => onPage(page + 1)} disabled={page >= pageCount - 1} aria-label="Next page">Next ›</button>
        <button className={btn} onClick={() => onPage(pageCount - 1)} disabled={page >= pageCount - 1} title="Last page" aria-label="Last page">»</button>
      </div>
      <label className="ml-3 flex items-center gap-1.5">
        Rows per page
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="rounded-md border bg-transparent px-1 py-0.5 text-xs"
          style={{ borderColor: "var(--border)", color: "var(--text)" }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** The Tools menu. New tools get added here, grouped under a heading. */
function ToolsMenu({ x, y, onClose, onPick }: { x: number; y: number; onClose: () => void; onPick: (tool: "duplicates" | "find") => void }) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const item = "flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-[var(--bg-inset)]";
  const groups: { title: string; items: { id: "duplicates" | "find"; label: string; hint: string; icon: typeof Copy }[] }[] = [
    {
      title: "Clean data",
      items: [
        { id: "duplicates", label: "Duplicate rows…", hint: "Find repeated rows and remove the incomplete copies", icon: Copy },
        { id: "find", label: "Find by keyword…", hint: "Find rows containing a word, then remove or fix them", icon: Search },
      ],
    },
  ];
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        role="menu"
        className="absolute w-72 animate-fade-in rounded-xl border p-1 shadow-xl"
        style={{ left: Math.min(x, window.innerWidth - 300), top: y + 4, background: "var(--bg-elevated)", borderColor: "var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {groups.map((g) => (
          <div key={g.title}>
            <p className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              {g.title}
            </p>
            {g.items.map((t) => (
              <button key={t.id} role="menuitem" className={item} onClick={() => onPick(t.id)}>
                <t.icon size={15} className="mt-0.5 shrink-0" color="var(--accent)" />
                <span>
                  <span className="block text-[13px] font-medium">{t.label}</span>
                  <span className="block text-[11px] leading-snug" style={{ color: "var(--text-faint)" }}>{t.hint}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ColumnMenu({
  x,
  y,
  column,
  kinds,
  onClose,
  onSort,
  onRename,
  onWidth,
  onInsert,
  onDelete,
  onKind,
  onClean,
}: {
  x: number;
  y: number;
  column: EditorColumn;
  kinds: { id: Kind; label: string }[];
  onClose: () => void;
  onSort: (ascending: boolean) => void;
  onRename: () => void;
  onWidth: (action: "fit" | "wider" | "narrower" | "reset") => void;
  onInsert: (right: boolean) => void;
  onDelete: () => void;
  onKind: (k: Kind) => void;
  onClean: (tool: "duplicates" | "find") => void;
}) {
  const [typesOpen, setTypesOpen] = useState(false);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const item = "block w-full rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-[var(--bg-inset)]";
  const left = Math.min(x, window.innerWidth - 256);
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        className="absolute w-60 animate-fade-in overflow-y-auto rounded-xl border p-1 shadow-xl"
        style={{ left, top: y + 4, maxHeight: `calc(100vh - ${y + 16}px)`, background: "var(--bg-elevated)", borderColor: "var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="truncate px-3 pb-1 pt-1.5 text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>
          {column.name} · {column.label}
        </p>
        <button className={item} onClick={() => onSort(true)}>Sort A → Z / smallest first</button>
        <button className={item} onClick={() => onSort(false)}>Sort Z → A / largest first</button>
        <div className="my-1 h-px" style={{ background: "var(--border)" }} />
        <button className={item} onClick={() => onWidth("fit")}>Fit width to content</button>
        <div className="flex gap-1 px-1">
          <button className={item + " text-center"} onClick={() => onWidth("narrower")}>− Narrower</button>
          <button className={item + " text-center"} onClick={() => onWidth("wider")}>+ Wider</button>
        </div>
        <button className={item} onClick={() => onWidth("reset")}>Reset width</button>
        <div className="my-1 h-px" style={{ background: "var(--border)" }} />
        <button className={item} onClick={onRename}>Rename…</button>
        <button className={item} onClick={() => setTypesOpen((v) => !v)}>Change type {typesOpen ? "▾" : "▸"}</button>
        {typesOpen && (
          <div className="mb-1 ml-3 border-l pl-1" style={{ borderColor: "var(--border)" }}>
            {kinds.map((k) => (
              <button
                key={k.id}
                className={item}
                disabled={k.id === column.kind}
                style={{ color: k.id === column.kind ? "var(--accent)" : undefined }}
                onClick={() => onKind(k.id)}
              >
                {k.label}
                {k.id === column.kind ? " ✓" : ""}
              </button>
            ))}
          </div>
        )}
        <button className={item} onClick={() => onInsert(false)}>Insert column left</button>
        <button className={item} onClick={() => onInsert(true)}>Insert column right</button>
        <div className="my-1 h-px" style={{ background: "var(--border)" }} />
        <button className={item} onClick={() => onClean("duplicates")}>Find duplicates in this column…</button>
        <button className={item} onClick={() => onClean("find")}>Search this column…</button>
        <div className="my-1 h-px" style={{ background: "var(--border)" }} />
        <button className={item} style={{ color: "#e11d48" }} onClick={onDelete}>Delete column</button>
      </div>
    </div>
  );
}

function EmptyState({
  recent,
  onOpen,
  onNew,
  onRecent,
}: {
  recent: RecentFile[];
  onOpen: () => void;
  onNew: () => void;
  onRecent: (path: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
        <span
          className="flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{ background: "color-mix(in srgb, #22d3ee 15%, transparent)" }}
        >
          <Table2 size={30} color="#0891b2" />
        </span>
        <h1 className="mt-5 text-xl font-semibold">Data Editor</h1>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Open a Parquet, Arrow, JSON, JSONL or CSV file and edit it like a spreadsheet. Pick a format at the top
          to save in it: that's also how you convert a file, for example JSON to Parquet.
        </p>
        <div className="mt-6 flex gap-2">
          <button
            onClick={onOpen}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
            style={{ background: "var(--accent)", color: "var(--accent-text)" }}
          >
            <FolderOpen size={15} /> Open a file…
          </button>
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--bg-inset)]"
            style={{ borderColor: "var(--border)" }}
          >
            <Plus size={15} /> New file
          </button>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
          <Upload size={12} /> or drop a file anywhere on this page
        </p>
        {recent.length > 0 && (
          <div className="mt-10 w-full text-left">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              Recent files
            </p>
            <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)" }}>
              {recent.map((f) => (
                <button
                  key={f.path}
                  onClick={() => onRecent(f.path)}
                  className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left last:border-b-0 hover:bg-[var(--bg-inset)]"
                  style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
                >
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ background: "var(--bg-inset)" }}>
                    {f.format}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
                      {f.folder}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
