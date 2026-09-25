import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  dataApi,
  type Cell,
  type CleanSelection,
  type DuplicateResult,
  type EditorColumn,
  type EditorMeta,
  type FindResult,
  type MatchMode,
} from "../dataEditorApi";
import { Copy, type LucideIcon, Search, Trash2, Wand2, X } from "../icons";

export type CleanToolId = "duplicates" | "find";
export type CleanStart = { tool: CleanToolId; cols?: number[] };

type ReplaceResult = { changed: number; errors: string[]; error_count: number } | undefined;

export interface CleanActions {
  /** delete the ticked rows (one undo step); true when it worked */
  removeFound: (selection: CleanSelection) => Promise<boolean>;
  /** replace (or with null, empty) the found text in the ticked rows */
  replaceText: (selection: CleanSelection, replacement: string | null) => Promise<ReplaceResult>;
  /** peek at a row in the sheet (the window steps aside until you come back) */
  showRow: (row: number) => void;
}

interface ToolProps {
  meta: EditorMeta;
  cols?: number[];
  actions: CleanActions;
}

// The Clean data tools. To add one: write a component taking ToolProps and
// list it here; it gets its own entry in the window's side list.
const TOOLS: { id: CleanToolId; label: string; hint: string; icon: LucideIcon; Tool: (p: ToolProps) => React.ReactNode }[] = [
  { id: "duplicates", label: "Duplicate rows", hint: "Rows that repeat; keep the most complete", icon: Copy, Tool: DuplicatesTool },
  { id: "find", label: "Find by keyword", hint: "Rows containing a word or value", icon: Search, Tool: FindTool },
];

/** The Clean data window: a floating window with its tools down the side. */
export function CleanData({
  meta,
  start,
  hidden,
  actions,
  onClose,
}: {
  meta: EditorMeta;
  start: CleanStart;
  hidden: boolean;
  actions: CleanActions;
  onClose: () => void;
}) {
  const [tool, setTool] = useState<CleanToolId>(start.tool);
  useEffect(() => setTool(start.tool), [start]);
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-5 ${hidden ? "hidden" : ""}`}
      style={{ background: "color-mix(in srgb, var(--bg) 35%, rgb(0 0 0 / 0.28))" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Clean data"
        className="auga-float flex h-[min(800px,90vh)] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-2xl"
        style={{ background: "var(--bg-elevated)" }}
      >
        <div className="flex items-center gap-3 border-b px-5 py-3" style={{ borderColor: "var(--border)" }}>
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)", color: "var(--accent)" }}
          >
            <Wand2 size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">Clean data</p>
            <p className="truncate text-xs" style={{ color: "var(--text-faint)" }}>
              {meta.name} · {meta.total_rows.toLocaleString()} rows · removals can be undone with Undo (⌘Z / Ctrl+Z)
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-[var(--bg-inset)]" aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-56 shrink-0 space-y-1 border-r p-2" style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}>
            {TOOLS.map((t) => {
              const on = t.id === tool;
              return (
                <button
                  key={t.id}
                  onClick={() => setTool(t.id)}
                  className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
                  style={{
                    background: on ? "var(--bg-elevated)" : undefined,
                    boxShadow: on ? "0 1px 3px rgb(0 0 0 / 0.08), 0 0 0 1px var(--border)" : undefined,
                  }}
                >
                  <t.icon size={15} className="mt-0.5 shrink-0" color={on ? "var(--accent)" : "var(--text-muted)"} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold" style={{ color: on ? "var(--accent)" : undefined }}>
                      {t.label}
                    </span>
                    <span className="block text-[11px] leading-snug" style={{ color: "var(--text-faint)" }}>{t.hint}</span>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            {TOOLS.map(({ id, Tool }) =>
              id === tool ? <Tool key={`${id}:${start.cols?.join(",") ?? ""}`} meta={meta} cols={id === start.tool ? start.cols : undefined} actions={actions} /> : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- shared pieces --------------------------------------------------------------

function ColumnPicker({
  columns,
  value,
  onChange,
  allLabel,
}: {
  columns: EditorColumn[];
  value: number[];
  onChange: (v: number[]) => void;
  allLabel: string;
}) {
  const chip = (on: boolean) => ({
    borderColor: on ? "var(--accent)" : "var(--border)",
    background: on ? "color-mix(in srgb, var(--accent) 12%, transparent)" : undefined,
    color: on ? "var(--accent)" : undefined,
  });
  return (
    <div className="flex flex-wrap gap-1.5">
      <button className="rounded-full border px-2.5 py-1 text-xs font-medium" style={chip(value.length === 0)} onClick={() => onChange([])}>
        {allLabel}
      </button>
      {columns.map((c, j) => {
        const on = value.includes(j);
        return (
          <button
            key={j}
            className="rounded-full border px-2.5 py-1 text-xs font-medium"
            style={chip(on)}
            onClick={() => onChange(on ? value.filter((x) => x !== j) : [...value, j].sort((a, b) => a - b))}
            title={`${c.name} · ${c.label}`}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 cursor-pointer"
      style={{ accentColor: "#e11d48" }}
    />
  );
}

function Button({ tone = "plain", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "plain" | "danger" | "accent" }) {
  const style =
    tone === "danger"
      ? { background: "#e11d48", color: "white", borderColor: "#e11d48" }
      : tone === "accent"
        ? { background: "var(--accent)", color: "var(--accent-text)", borderColor: "var(--accent)" }
        : { borderColor: "var(--border)" };
  return (
    <button
      {...props}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-40 ${
        tone === "plain" ? "hover:bg-[var(--bg-inset)]" : ""
      }`}
      style={style}
    />
  );
}

/** What was searched for, to highlight it the same way the search matched. */
type Highlight = { text: string; match: MatchMode; caseSensitive: boolean };

/** Where `h` occurs in `text`, following the same rules as the search. */
function findRanges(text: string, h: Highlight | undefined): [number, number][] {
  if (!h?.text) return [];
  const flags = h.caseSensitive ? "gu" : "giu";
  if (h.match === "exact") {
    const start = text.length - text.trimStart().length;
    const body = text.trim();
    const same = h.caseSensitive ? body === h.text.trim() : body.toLowerCase() === h.text.trim().toLowerCase();
    return same && body ? [[start, start + body.length]] : [];
  }
  const esc = h.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source =
    h.match === "word" ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : h.match === "starts" ? `^\\s*${esc}` : esc;
  const out: [number, number][] = [];
  try {
    for (const m of text.matchAll(new RegExp(source, flags))) {
      if (!m[0]) break;
      const lead = h.match === "starts" ? m[0].length - m[0].trimStart().length : 0;
      out.push([m.index! + lead, m.index! + m[0].length]);
    }
  } catch {
    /* an odd pattern: just no highlight */
  }
  return out;
}

const MARK_STYLE: React.CSSProperties = {
  background: "#fde047",
  color: "#1c1917",
  borderRadius: 3,
  padding: "0 2px",
  fontWeight: 600,
  boxShadow: "0 0 0 1px #eab308",
};

/** A cell's text with the searched-for text highlighted. */
function Marked({ text, highlight }: { text: string; highlight?: Highlight }) {
  const ranges = findRanges(text, highlight);
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    out.push(text.slice(at, a), <mark key={a} data-hit style={MARK_STYLE}>{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

function cellString(value: Cell): string {
  if (value === null || value === undefined) return "";
  return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}

function CellText({ value, highlight }: { value: Cell; highlight?: Highlight }) {
  const text = cellString(value);
  if (!text) return <span className="italic" style={{ color: "var(--text-faint)" }}>empty</span>;
  return <Marked text={text} highlight={highlight} />;
}

/**
 * The full text of a cell that doesn't fit, shown on hover, with the searched
 * text highlighted; it scrolls to the first match in long paragraphs. The
 * pointer passes through it (to the rows below); the mouse wheel over the
 * cell scrolls it.
 */
function HoverCard({
  card,
  bodyRef,
}: {
  card: { rect: DOMRect; text: string; column: string; highlight?: Highlight };
  bodyRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = bodyRef;
  const [long, setLong] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const width = Math.min(560, Math.max(340, card.rect.width + 40), window.innerWidth - 32);
  const hits = findRanges(card.text, card.highlight).length;

  useLayoutEffect(() => {
    const r = card.rect;
    const below = window.innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const h = ref.current?.offsetHeight ?? 200;
    const useBelow = below >= Math.min(h, 240) || below >= above;
    const maxHeight = Math.max(160, Math.min(420, useBelow ? below : above));
    setPos({
      left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)),
      top: useBelow ? r.bottom + 6 : Math.max(16, r.top - 6 - Math.min(h, maxHeight)),
      maxHeight,
    });
  }, [card, width]);

  useEffect(() => {
    const body = ref.current;
    if (!body) return;
    const hit = body.querySelector<HTMLElement>("[data-hit]");
    if (hit) body.scrollTop = Math.max(0, hit.offsetTop - body.clientHeight / 2 + hit.offsetHeight / 2);
    setLong(body.scrollHeight > body.clientHeight + 1);
  }, [pos, ref]);

  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[70] flex animate-fade-in flex-col overflow-hidden rounded-xl border shadow-2xl"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        maxHeight: pos?.maxHeight ?? 420,
        background: "var(--bg-elevated)",
        borderColor: "var(--border)",
      }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] font-semibold"
        style={{ borderColor: "var(--border)", background: "var(--bg-inset)", color: "var(--text-muted)" }}
      >
        <span className="truncate">
          {card.column}
          {long && <span className="font-normal" style={{ color: "var(--text-faint)" }}> · scroll to read more</span>}
        </span>
        {hits > 0 && (
          <span className="shrink-0 rounded-full px-1.5 py-0.5" style={{ background: "#fef08a", color: "#713f12" }}>
            {hits} match{hits === 1 ? "" : "es"}
          </span>
        )}
      </div>
      <div ref={ref} className="relative overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[13px] leading-relaxed">
        <Marked text={card.text} highlight={card.highlight} />
      </div>
    </div>,
    document.body,
  );
}

/** Rows shown like the sheet: a tick box to pick rows, then every column. */
function RowsTable({
  columns,
  rows,
  isPicked,
  onPick,
  lead,
  leadLabel,
  keyCols,
  hit,
  highlight,
  onRowNumber,
}: {
  columns: EditorColumn[];
  rows: { i: number; values: Cell[] }[];
  isPicked: (row: number) => boolean;
  onPick: (row: number, on: boolean) => void;
  lead?: (row: number) => React.ReactNode;
  leadLabel?: string;
  keyCols?: Set<number>;
  hit?: (row: number, col: number) => boolean;
  highlight?: Highlight;
  onRowNumber: (row: number) => void;
}) {
  // hover card for cells whose text doesn't fit
  const [card, setCard] = useState<{ rect: DOMRect; text: string; column: string; highlight?: Highlight } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hovered = useRef<HTMLElement | null>(null);
  const cardBody = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  // the wheel over the hovered cell scrolls the card instead of the list
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const onWheel = (e: WheelEvent) => {
      const body = cardBody.current;
      if (!body || !hovered.current?.contains(e.target as Node)) return;
      if (body.scrollHeight <= body.clientHeight) return;
      const atTop = body.scrollTop <= 0 && e.deltaY < 0;
      const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 1 && e.deltaY > 0;
      if (atTop || atEnd) return; // at the end: let the list scroll on
      body.scrollTop += e.deltaY;
      e.preventDefault();
    };
    table.addEventListener("wheel", onWheel, { passive: false });
    return () => table.removeEventListener("wheel", onWheel);
  }, []);
  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!card) return;
    const hide = () => setCard(null);
    // scrolling the results moves the cell away; scrolling inside the card doesn't count
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest('[role="tooltip"]'))) hide();
    };
    // the card follows the pointer's cell: a click or key closes it too
    window.addEventListener("keydown", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", hide);
    };
  }, [card]);
  const th = "sticky top-0 z-[1] border-b px-2.5 py-1.5 text-left text-[11.5px] font-semibold whitespace-nowrap";
  return (
    <table ref={tableRef} className="w-full border-separate border-spacing-0 text-[12.5px]">
      <thead>
        <tr>
          <th className={th + " w-8"} style={{ background: "var(--bg-inset)", borderColor: "var(--border)" }} />
          <th className={th + " w-12 text-right"} style={{ background: "var(--bg-inset)", borderColor: "var(--border)", color: "var(--text-faint)" }}>Row</th>
          {lead && <th className={th} style={{ background: "var(--bg-inset)", borderColor: "var(--border)" }}>{leadLabel}</th>}
          {columns.map((c, j) => (
            <th
              key={j}
              className={th}
              style={{
                borderColor: "var(--border)",
                background: keyCols?.has(j) ? "color-mix(in srgb, var(--accent) 14%, var(--bg-inset))" : "var(--bg-inset)",
                color: keyCols?.has(j) ? "var(--accent)" : undefined,
              }}
            >
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const on = isPicked(r.i);
          const bg = on ? "color-mix(in srgb, #e11d48 8%, var(--bg-elevated))" : undefined;
          return (
            <tr key={r.i} style={{ background: bg }}>
              <td className="border-b px-2.5 py-1.5" style={{ borderColor: "var(--border)" }}>
                <Check checked={on} onChange={(v) => onPick(r.i, v)} label={`Remove row ${r.i + 1}`} />
              </td>
              <td className="border-b px-2.5 py-1.5 text-right tabular-nums" style={{ borderColor: "var(--border)" }}>
                <button
                  className="rounded px-1 font-medium underline-offset-2 hover:underline"
                  style={{ color: "var(--accent)" }}
                  onClick={() => onRowNumber(r.i)}
                  title="Show this row in the sheet"
                >
                  {r.i + 1}
                </button>
              </td>
              {lead && (
                <td className="border-b px-2.5 py-1.5 whitespace-nowrap" style={{ borderColor: "var(--border)" }}>
                  {lead(r.i)}
                </td>
              )}
              {r.values.map((v, j) => (
                <td
                  key={j}
                  className="max-w-[280px] border-b px-2.5 py-1.5 align-top"
                  style={{
                    borderColor: "var(--border)",
                    background: hit?.(r.i, j) ? "color-mix(in srgb, #fbbf24 16%, transparent)" : undefined,
                    textDecoration: on ? "line-through" : undefined,
                    textDecorationColor: "color-mix(in srgb, #e11d48 55%, transparent)",
                  }}
                >
                  <div
                    className="line-clamp-3 break-words"
                    onMouseEnter={(e) => {
                      const el = e.currentTarget;
                      hovered.current = el;
                      const text = cellString(v);
                      const cut = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
                      if (!text || !cut) return later(() => setCard(null), 120);
                      later(
                        () =>
                          setCard({
                            rect: el.getBoundingClientRect(),
                            text,
                            column: columns[j].name,
                            highlight: hit?.(r.i, j) ? highlight : undefined,
                          }),
                        card ? 60 : 280,
                      );
                    }}
                    onMouseLeave={() => {
                      hovered.current = null;
                      later(() => setCard(null), 120);
                    }}
                  >
                    <CellText value={v} highlight={hit?.(r.i, j) ? highlight : undefined} />
                  </div>
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
      {card && <HoverCard card={card} bodyRef={cardBody} />}
    </table>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center text-sm" style={{ color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}

/**
 * Ticked rows, kept as "all the search's rows" (or none) plus the rows
 * ticked / unticked by hand, so a search with a million results never needs
 * a million row numbers here.
 */
function useTicks(defaultBase: "suggested" | "all") {
  const [base, setBase] = useState<"suggested" | "all" | "none">(defaultBase);
  const [add, setAdd] = useState<Set<number>>(new Set());
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const reset = useCallback((b: "suggested" | "all" | "none") => {
    setBase(b);
    setAdd(new Set());
    setSkip(new Set());
  }, []);
  /** inBase: whether the search itself counts this row (suggested / found) */
  const isPicked = (row: number, inBase: boolean) => add.has(row) || (inBase && base !== "none" && !skip.has(row));
  const toggle = (row: number, on: boolean, inBase: boolean) => {
    const edit = (set: Set<number>, put: boolean) => {
      const next = new Set(set);
      if (put) next.add(row);
      else next.delete(row);
      return next;
    };
    if (inBase && base !== "none") setSkip((x) => edit(x, !on));
    else setAdd((x) => edit(x, on));
  };
  const count = (baseCount: number) => (base === "none" ? 0 : baseCount - skip.size) + add.size;
  const selection = (search: Omit<CleanSelection, "base" | "add" | "skip">): CleanSelection => ({
    ...search,
    base,
    add: [...add],
    skip: [...skip],
  });
  return { base, reset, isPicked, toggle, count, selection };
}

/**
 * Runs a search whenever `deps` change and only ever shows the answer to the
 * latest one. While it runs, `loading` is true and the old answer is gone, so
 * a stale "nothing found" is never on screen while the real answer is coming.
 */
function useSearch<T>(run: () => Promise<T>, deps: unknown[], { enabled = true, delay = 0 } = {}) {
  // Each answer is tagged with the options it was searched with; an answer
  // for other options than the current ones is never shown.
  const key = JSON.stringify([enabled, ...deps]);
  const [state, setState] = useState<{ key: string; result: T | null; error: string | null; running: boolean }>({
    key: "",
    result: null,
    error: null,
    running: false,
  });
  const runRef = useRef(run);
  runRef.current = run;
  const keyRef = useRef(key);
  keyRef.current = key;

  const refresh = useCallback(async () => {
    const forKey = keyRef.current;
    const started = performance.now();
    setState((s) => ({ ...s, running: true }));
    try {
      const result = await runRef.current();
      // keep the searching animation up for a moment, so a new answer is
      // clearly a new answer even when it comes back instantly
      const wait = 350 - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (forKey === keyRef.current) setState({ key: forKey, result, error: null, running: false });
    } catch (e) {
      if (forKey === keyRef.current)
        setState({ key: forKey, result: null, error: e instanceof Error ? e.message : String(e), running: false });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(refresh, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = state.key === key;
  return {
    result: enabled && current && !state.running ? state.result : null,
    error: enabled && current && !state.running ? state.error : null,
    loading: enabled && (!current || state.running),
    refresh,
  };
}

/** Shown while a search runs: a moving bar, a spinner, and placeholder rows. */
function Searching({ label }: { label: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="relative">
      <div className="auga-progress absolute inset-x-0 top-0 h-0.5" />
      <div className="flex items-center gap-3 px-5 pb-2 pt-6 text-sm" style={{ color: "var(--text-muted)" }}>
        <span
          className="h-4 w-4 animate-spin rounded-full border-2"
          style={{ borderColor: "color-mix(in srgb, var(--accent) 25%, transparent)", borderTopColor: "var(--accent)" }}
        />
        {label}
      </div>
      <div className="space-y-2.5 px-5 py-3">
        {[0.92, 0.78, 0.85, 0.6, 0.72].map((w, k) => (
          <div key={k} className="auga-shimmer h-9 rounded-lg" style={{ width: `${w * 100}%`, animationDelay: `${k * 90}ms` }} />
        ))}
      </div>
    </div>
  );
}

function columnNames(meta: EditorMeta, cols: number[], all: string): string {
  if (!cols.length) return all;
  const names = cols.map((j) => meta.columns[j]?.name).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}

// ---- Duplicate rows -------------------------------------------------------------

function DuplicatesTool({ meta, cols, actions }: ToolProps) {
  const [keyCols, setKeyCols] = useState<number[]>(cols ?? []);
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [groups, setGroups] = useState<DuplicateResult["groups"]>([]);
  const ticks = useTicks("suggested");

  // search again when the options change, or after the file changed (rows removed...)
  const { result, loading, error } = useSearch(
    () => dataApi.duplicates(meta.id, { cols: keyCols, ignore_case: ignoreCase }),
    [meta.id, meta.total_rows, keyCols, ignoreCase],
  );
  useEffect(() => {
    setGroups(result?.groups ?? []);
    ticks.reset("suggested"); // the least complete copies, ready to remove
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  async function more() {
    if (!result) return;
    const r = await dataApi.duplicates(meta.id, { cols: keyCols, ignore_case: ignoreCase, offset: groups.length });
    setGroups((g) => [...g, ...r.groups]);
  }

  const keySet = new Set(keyCols.length ? keyCols : meta.columns.map((_, j) => j));
  const suggested = result?.suggested_count ?? 0;
  const inBase = new Map(groups.flatMap((g) => g.rows.map((r) => [r.i, !r.keep] as const)));
  const picked = (i: number) => ticks.isPicked(i, inBase.get(i) ?? false);
  const n = ticks.count(suggested);
  const wholeGroupPicked = groups.some((g) => g.size === g.rows.length && g.rows.every((r) => picked(r.i)));

  return (
    <>
      <div className="space-y-3 border-b px-5 py-4" style={{ borderColor: "var(--border)" }}>
        <div>
          <p className="mb-1.5 text-[13px] font-semibold">Rows are duplicates when these columns match</p>
          <ColumnPicker columns={meta.columns} value={keyCols} onChange={setKeyCols} allLabel="All columns (exact copies)" />
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
          <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} />
          Ignore upper/lower case and extra spaces
        </label>
      </div>

      {!loading && result && result.total_groups > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5" style={{ borderColor: "var(--border)" }}>
          <p className="mr-auto text-xs" style={{ color: "var(--text-muted)" }}>
            <b style={{ color: "var(--text)" }}>{result.total_groups.toLocaleString()}</b> group
            {result.total_groups === 1 ? "" : "s"} of duplicates. In each, the row with the least data is ticked for removal.
          </p>
          <Button onClick={() => ticks.reset("suggested")}>Tick suggested ({suggested.toLocaleString()})</Button>
          <Button onClick={() => ticks.reset("none")} disabled={!n}>Untick all</Button>
          <Button
            tone="danger"
            disabled={!n || loading}
            onClick={async () => {
              if (wholeGroupPicked && !confirm("Some groups would lose every copy. Remove them anyway?")) return;
              if (n > 1000 && !confirm(`Remove ${n.toLocaleString()} rows?`)) return;
              await actions.removeFound(ticks.selection({ tool: "duplicates", cols: keyCols, ignore_case: ignoreCase }));
            }}
          >
            <Trash2 size={13} /> Remove {n.toLocaleString()} row{n === 1 ? "" : "s"}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <Searching
            label={
              <span>
                Looking for duplicate rows by <b>{columnNames(meta, keyCols, "all columns")}</b>…
              </span>
            }
          />
        ) : error ? (
          <Empty><span style={{ color: "#e11d48" }}>✖ {error}</span></Empty>
        ) : !result ? null : result.total_groups === 0 ? (
          <Empty>
            <span>
              <span className="mb-1 block text-2xl">✓</span>
              No duplicate rows{keyCols.length ? " for these columns" : ""}.
            </span>
          </Empty>
        ) : (
          <div className="space-y-4 p-5">
            {groups.map((g, k) => {
              const keep = g.rows[0];
              return (
                <section key={keep.i} className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)" }}>
                  <p className="px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-inset)" }}>
                    Group {k + 1} · {g.size.toLocaleString()} matching rows
                    <span className="font-normal" style={{ color: "var(--text-faint)" }}>
                      {" "}·{" "}
                      {[...keySet].slice(0, 3).map((j) => `${meta.columns[j].name}: ${keep.values[j] ?? "empty"}`).join(" · ")}
                      {keySet.size > 3 ? " …" : ""}
                    </span>
                  </p>
                  <div className="overflow-x-auto">
                    <RowsTable
                      columns={meta.columns}
                      rows={g.rows}
                      isPicked={picked}
                      onPick={(i, on) => ticks.toggle(i, on, inBase.get(i) ?? false)}
                      keyCols={keySet}
                      onRowNumber={actions.showRow}
                      leadLabel="Data"
                      lead={(i) => {
                        const r = g.rows.find((x) => x.i === i)!;
                        const pct = r.of ? r.filled / r.of : 0;
                        return (
                          <span className="flex items-center gap-2">
                            <span className="h-1.5 w-12 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                              <span
                                className="block h-full rounded-full"
                                style={{ width: `${pct * 100}%`, background: pct >= 0.999 ? "#22c55e" : pct >= 0.5 ? "#f59e0b" : "#e11d48" }}
                              />
                            </span>
                            <span className="tabular-nums text-[11px]" style={{ color: "var(--text-muted)" }}>
                              {r.filled}/{r.of}
                            </span>
                            {r.keep ? (
                              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "#dcfce7", color: "#166534" }}>
                                most complete
                              </span>
                            ) : r.filled < keep.filled ? (
                              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "#ffe4e6", color: "#9f1239" }}>
                                missing data
                              </span>
                            ) : (
                              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "var(--bg-inset)", color: "var(--text-muted)" }}>
                                same data
                              </span>
                            )}
                          </span>
                        );
                      }}
                    />
                  </div>
                  {g.size > g.rows.length && (
                    <p className="border-t px-3 py-2 text-[11.5px]" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                      + {(g.size - g.rows.length).toLocaleString()} more matching row{g.size - g.rows.length === 1 ? "" : "s"} not shown
                      {ticks.base === "suggested" ? ", also ticked for removal" : ""}.
                    </p>
                  )}
                </section>
              );
            })}
            {groups.length < result.total_groups && (
              <div className="flex justify-center">
                <Button onClick={more}>Show more groups ({(result.total_groups - groups.length).toLocaleString()} left)</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ---- Find by keyword ------------------------------------------------------------

const MATCH_LABELS: { id: MatchMode; label: string }[] = [
  { id: "contains", label: "Contains" },
  { id: "word", label: "Whole word" },
  { id: "exact", label: "Whole cell" },
  { id: "starts", label: "Starts with" },
];

function FindTool({ meta, cols, actions }: ToolProps) {
  const [text, setText] = useState("");
  const [searchCols, setSearchCols] = useState<number[]>(cols ?? []);
  const [match, setMatch] = useState<MatchMode>("contains");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [rows, setRows] = useState<FindResult["rows"]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const ticks = useTicks("all");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const opts = { text: text.trim() ? text : "", cols: searchCols, match, case_sensitive: caseSensitive };
  // search as you type (a moment after the last key), and after the file changes
  const { result, loading, error: searchError, refresh } = useSearch(
    () => dataApi.find(meta.id, opts),
    [meta.id, meta.total_rows, text, searchCols, match, caseSensitive],
    { enabled: !!opts.text, delay: 250 },
  );
  useEffect(() => {
    setRows(result?.rows ?? []);
    ticks.reset("all"); // every matching row, ready to clean
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  useEffect(() => setActionError(null), [text, searchCols, match, caseSensitive]);
  const error = actionError ?? searchError;

  async function more() {
    const r = await dataApi.find(meta.id, { ...opts, offset: rows.length });
    setRows((x) => [...x, ...r.rows]);
  }

  async function replace(value: string | null) {
    setBusy(true);
    const res = await actions.replaceText(ticks.selection({ tool: "find", ...opts }), value);
    setBusy(false);
    setActionError(res?.error_count ? res.errors[0] + (res.error_count > 1 ? ` (and ${res.error_count - 1} more)` : "") : null);
    await refresh();
  }

  const hits = new Map(rows.map((r) => [r.i, new Set(r.matched)]));
  const n = ticks.count(result?.total_rows ?? 0);
  const rowsWord = `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;

  return (
    <>
      <div className="space-y-3 border-b px-5 py-4" style={{ borderColor: "var(--border)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[260px] flex-1 items-center gap-2 rounded-lg border px-3 py-2 focus-within:ring-2" style={{ borderColor: "var(--border)" }}>
            <Search size={15} color="var(--text-faint)" />
            <input
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && opts.text && refresh()}
              placeholder="Type a word or value to find, e.g. test, N/A, spam"
              aria-label="Search for"
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
          <div className="flex rounded-lg border p-0.5" style={{ borderColor: "var(--border)" }} role="radiogroup" aria-label="Match">
            {MATCH_LABELS.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={match === m.id}
                onClick={() => setMatch(m.id)}
                className="rounded-md px-2.5 py-1 text-xs font-medium"
                style={{
                  background: match === m.id ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined,
                  color: match === m.id ? "var(--accent)" : "var(--text-muted)",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            Match case
          </label>
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-semibold">Search in</p>
          <ColumnPicker columns={meta.columns} value={searchCols} onChange={setSearchCols} allLabel="Every column" />
        </div>
      </div>

      {!loading && result && result.total_rows > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5" style={{ borderColor: "var(--border)" }}>
          <p className="mr-auto text-xs" style={{ color: "var(--text-muted)" }}>
            Found in <b style={{ color: "var(--text)" }}>{result.total_rows.toLocaleString()}</b> row{result.total_rows === 1 ? "" : "s"}
            {" "}({result.total_cells.toLocaleString()} cell{result.total_cells === 1 ? "" : "s"}) · {rowsWord} ticked
          </p>
          <Button onClick={() => ticks.reset("all")}>Tick all</Button>
          <Button onClick={() => ticks.reset("none")} disabled={!n}>Untick all</Button>
          <span className="basis-full" />
          <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Ticked rows:</span>
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="replace with… (blank removes it)"
            aria-label="Replace with"
            className="w-56 rounded-lg border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-2"
            style={{ borderColor: "var(--border)" }}
          />
          <Button tone="accent" disabled={!n || busy} onClick={() => replace(replacement)} title="Replace the found text in the ticked rows">
            Replace in {rowsWord}
          </Button>
          <Button disabled={!n || busy} onClick={() => replace(null)} title="Empty every matching cell in the ticked rows">
            Empty the cells
          </Button>
          <span className="flex-1" />
          <Button
            tone="danger"
            disabled={!n || busy}
            onClick={async () => {
              if (n > 20 && !confirm(`Remove ${rowsWord}?`)) return;
              setBusy(true);
              await actions.removeFound(ticks.selection({ tool: "find", ...opts }));
              setBusy(false);
            }}
          >
            <Trash2 size={13} /> Remove {rowsWord}
          </Button>
        </div>
      )}
      {error && <p className="border-b px-5 py-2 text-xs" style={{ color: "#e11d48", borderColor: "var(--border)" }}>✖ {error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {!opts.text ? (
          <Empty>
            <span>
              Type what to look for. Rows containing it are listed here, ready to remove, or to
              <br />
              have the text replaced. Pick columns under <b>Search in</b> to look only there.
            </span>
          </Empty>
        ) : loading ? (
          <Searching
            label={
              <span>
                Searching <b>{columnNames(meta, searchCols, "every column")}</b> for “{text}”…
              </span>
            }
          />
        ) : !result ? null : result.total_rows === 0 ? (
          <Empty>Nothing found for “{text}”{searchCols.length ? " in these columns" : ""}.</Empty>
        ) : (
          <>
            <RowsTable
              columns={meta.columns}
              rows={rows}
              isPicked={(i) => ticks.isPicked(i, true)}
              onPick={(i, on) => ticks.toggle(i, on, true)}
              keyCols={new Set(result?.columns.length === meta.columns.length ? [] : result?.columns)}
              hit={(i, j) => hits.get(i)?.has(j) ?? false}
              highlight={{ text, match, caseSensitive }}
              onRowNumber={actions.showRow}
            />
            {result && rows.length < result.total_rows && (
              <div className="flex justify-center p-4">
                <Button onClick={more}>Show more rows ({(result.total_rows - rows.length).toLocaleString()} left)</Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
