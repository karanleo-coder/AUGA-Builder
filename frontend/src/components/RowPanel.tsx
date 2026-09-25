import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell, EditorMeta, Kind } from "../dataEditorApi";
import { X } from "../icons";

/**
 * One row in a floating window, laid out like the sheet (columns side by
 * side) but with every value shown in full. Prev / Next move through the
 * rows without closing it.
 */
export function RowPanel({
  meta,
  rowIndex,
  values,
  widths,
  onClose,
  onMove,
  onSave,
}: {
  meta: EditorMeta;
  rowIndex: number;
  values: Cell[] | null;
  /** each column's width in the sheet (100% zoom), to size the columns here alike */
  widths: number[] | null;
  onClose: () => void;
  onMove: (delta: number) => void;
  onSave: (changes: [number, string | null][]) => Promise<string[]>;
}) {
  const original = useMemo(() => (values ?? []).map((v) => (v === null || v === undefined ? "" : String(v))), [values]);
  const [draft, setDraft] = useState<string[]>(original);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(original);
    setErrors([]);
  }, [original, rowIndex]);

  const changed = draft.map((v, j) => v !== original[j]);
  const dirty = changed.some(Boolean);

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    setSaving(true);
    const changes = draft
      .map((v, j): [number, string | null] => [j, v === "" ? null : v])
      .filter((_, j) => changed[j]);
    const errs = await onSave(changes);
    setSaving(false);
    setErrors(errs);
    return errs.length === 0;
  }

  async function move(delta: number) {
    const target = rowIndex + delta;
    if (target < 0 || target >= meta.total_rows) return;
    if (await save()) onMove(delta);
  }

  function close() {
    if (dirty && !confirm(`Discard your changes to row ${rowIndex + 1}?`)) return;
    onClose();
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter" && mod) {
        e.preventDefault();
        save();
      } else if (mod && e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const set = (j: number, v: string) => setDraft((d) => d.map((x, k) => (k === j ? v : x)));
  const colWidth = (j: number) => Math.max(180, Math.min(440, widths?.[j] ?? 200));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "color-mix(in srgb, var(--bg) 35%, rgb(0 0 0 / 0.28))" }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-label={`Row ${rowIndex + 1}`}
        className="auga-float flex max-h-[86vh] w-fit min-w-[min(560px,94vw)] max-w-[94vw] flex-col overflow-hidden rounded-2xl"
        style={{ background: "var(--bg-elevated)" }}
      >
        {/* header: which row, and moving between rows */}
        <div className="flex items-center gap-2 border-b px-5 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">
              Row {(rowIndex + 1).toLocaleString()}
              <span className="font-normal" style={{ color: "var(--text-faint)" }}>
                {" "}of {meta.total_rows.toLocaleString()}
              </span>
              {dirty && (
                <span className="ml-2 text-xs font-medium" style={{ color: "var(--accent)" }}>
                  ● unsaved changes
                </span>
              )}
            </p>
          </div>
          <PanelButton onClick={() => move(-1)} disabled={rowIndex <= 0 || saving} title="Previous row (⌘⇧↑ / Ctrl+Shift+↑)">
            ◂ Prev row
          </PanelButton>
          <PanelButton
            onClick={() => move(1)}
            disabled={rowIndex >= meta.total_rows - 1 || saving}
            title="Next row (⌘⇧↓ / Ctrl+Shift+↓)"
          >
            Next row ▸
          </PanelButton>
          <button onClick={close} className="ml-1 rounded-lg p-1.5 hover:bg-[var(--bg-inset)]" aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        </div>

        {/* the row, laid out like the sheet */}
        <div className="min-h-0 flex-1 overflow-auto">
          {values === null ? (
            <p className="p-6 text-sm" style={{ color: "var(--text-faint)" }}>Loading…</p>
          ) : (
            <table className="auga-row-table border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10">
                <tr>
                  {meta.columns.map((c, j) => (
                    <th
                      key={j}
                      className="border-b px-3 py-2 text-left font-normal"
                      style={{ minWidth: colWidth(j), maxWidth: 440, borderColor: "var(--border)", background: "var(--bg-inset)" }}
                    >
                      <span className="block truncate text-[13px] font-semibold" title={c.name}>
                        {c.name}
                        {changed[j] && <span style={{ color: "var(--accent)" }}> ●</span>}
                      </span>
                      <span className="block text-[10.5px]" style={{ color: "var(--text-faint)" }}>{c.label}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {meta.columns.map((c, j) => (
                    <td key={j} className="p-2" style={{ minWidth: colWidth(j), maxWidth: 440 }}>
                      <Field kind={c.kind} value={draft[j] ?? ""} onChange={(v) => set(j, v)} label={c.name} />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          )}
        </div>

        {/* footer: problems, and saving */}
        <div className="flex items-center gap-3 border-t px-5 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0 flex-1 text-xs">
            {errors.length ? (
              errors.map((e, i) => (
                <p key={i} style={{ color: "#e11d48" }}>✖ {e}</p>
              ))
            ) : (
              <p style={{ color: "var(--text-faint)" }}>
                Moving to another row applies your changes · ⌘Enter / Ctrl+Enter applies · Esc closes
              </p>
            )}
          </div>
          <PanelButton onClick={() => setDraft(original)} disabled={!dirty}>Reset</PanelButton>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-lg px-4 py-1.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-text)" }}
          >
            {saving ? "Saving…" : "Apply changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PanelButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-inset)] disabled:opacity-40"
      style={{ borderColor: "var(--border)" }}
    />
  );
}

/** A textarea that grows with its text, so every word stays visible. */
function GrowingText({ value, onChange, className, style, label }: {
  value: string;
  onChange: (v: string) => void;
  className: string;
  style: React.CSSProperties;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      rows={1}
      className={className + " resize-none overflow-hidden leading-snug"}
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Field({ kind, value, onChange, label }: { kind: Kind; value: string; onChange: (v: string) => void; label: string }) {
  const cls = "w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2";
  const style = { borderColor: "var(--border)", color: "var(--text)" };
  if (kind === "other") {
    return (
      <pre className="whitespace-pre-wrap break-words rounded-lg border p-2 text-xs" style={{ ...style, background: "var(--bg-inset)" }}>
        {value}
      </pre>
    );
  }
  if (kind === "boolean") {
    const v = value === "true" ? "yes" : value === "false" ? "no" : value;
    return (
      <select aria-label={label} className={cls} style={style} value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">(empty)</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (kind === "date") {
    return <input aria-label={label} type="date" className={cls} style={style} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (kind === "datetime") {
    return (
      <input
        aria-label={label}
        type="datetime-local"
        className={cls}
        style={style}
        value={value.replace(" ", "T").slice(0, 16)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (kind === "integer" || kind === "decimal") {
    return (
      <input
        aria-label={label}
        inputMode="decimal"
        className={cls + " text-right tabular-nums"}
        style={style}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return <GrowingText label={label} className={cls} style={style} value={value} onChange={onChange} />;
}
