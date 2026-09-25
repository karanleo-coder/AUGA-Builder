import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FormatId, FormatsInfo, Kind } from "../dataEditorApi";
import { Plus, Trash2, X } from "../icons";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-lg animate-fade-in rounded-2xl border p-5 shadow-2xl"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-[var(--bg-inset)]" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputClass = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2";
const inputStyle = { borderColor: "var(--border)" };

function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
      style={{ background: "var(--accent)", color: "var(--accent-text)" }}
    />
  );
}

function FormatPicker({ info, value, onChange }: { info: FormatsInfo; value: FormatId; onChange: (f: FormatId) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {info.formats.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => onChange(f.id)}
          className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
          style={{
            borderColor: value === f.id ? "var(--accent)" : "var(--border)",
            background: value === f.id ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** New file: name, format and columns. */
export function NewFileDialog({
  info,
  initialFormat,
  onCreate,
  onClose,
}: {
  info: FormatsInfo;
  initialFormat: FormatId;
  onCreate: (columns: { name: string; kind: Kind }[], format: FormatId) => Promise<void>;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<FormatId>(initialFormat);
  const [columns, setColumns] = useState<{ name: string; kind: Kind }[]>([
    { name: "name", kind: "text" },
    { name: "value", kind: "decimal" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<{ name: string; kind: Kind }>) =>
    setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  async function create() {
    const names = columns.map((c) => c.name.trim());
    if (names.some((n) => !n)) return setError("Every column needs a name.");
    if (new Set(names).size !== names.length) return setError("Column names must be different.");
    setBusy(true);
    try {
      await onCreate(columns.map((c) => ({ ...c, name: c.name.trim() })), format);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="New file" onClose={onClose}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        Format
      </p>
      <FormatPicker info={info} value={format} onChange={setFormat} />
      <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        Columns
      </p>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {columns.map((c, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={c.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Column name"
              className={inputClass}
              style={inputStyle}
              autoFocus={i === 0}
            />
            <select
              value={c.kind}
              onChange={(e) => update(i, { kind: e.target.value as Kind })}
              className="rounded-lg border bg-transparent px-2 text-sm"
              style={inputStyle}
            >
              {info.kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setColumns((cols) => cols.filter((_, j) => j !== i))}
              disabled={columns.length === 1}
              className="rounded-lg border px-2 hover:bg-[var(--bg-inset)] disabled:opacity-30"
              style={inputStyle}
              aria-label="Remove column"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => setColumns((cols) => [...cols, { name: "", kind: "text" }])}
        className="mt-2 flex items-center gap-1 text-xs font-medium"
        style={{ color: "var(--accent)" }}
      >
        <Plus size={13} /> Add column
      </button>
      {error && <p className="mt-3 text-xs" style={{ color: "#e11d48" }}>{error}</p>}
      <div className="mt-5 flex justify-end">
        <PrimaryButton onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

/** Save as, when there's no native Save dialog (browser mode). */
export function SaveAsDialog({
  info,
  defaultName,
  format,
  onSave,
  onClose,
}: {
  info: FormatsInfo;
  defaultName: string;
  format: FormatId;
  onSave: (filename: string, format: FormatId) => Promise<void>;
  onClose: () => void;
}) {
  const [fmt, setFmt] = useState<FormatId>(format);
  const [name, setName] = useState(defaultName.replace(/\.[^.]+$/, ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ext = info.formats.find((f) => f.id === fmt)?.ext ?? "";

  async function save() {
    if (!name.trim()) return setError("Give the file a name.");
    setBusy(true);
    try {
      await onSave(name.trim() + ext, fmt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Save as" onClose={onClose}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        Format
      </p>
      <FormatPicker info={info} value={fmt} onChange={setFmt} />
      <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
        File name
      </p>
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className={inputClass}
          style={inputStyle}
          autoFocus
        />
        <span className="font-mono text-sm" style={{ color: "var(--text-muted)" }}>
          {ext}
        </span>
      </div>
      <p className="mt-2 break-all text-xs" style={{ color: "var(--text-faint)" }}>
        Saved in {info.files_dir}
      </p>
      {error && <p className="mt-3 text-xs" style={{ color: "#e11d48" }}>{error}</p>}
      <div className="mt-5 flex justify-end">
        <PrimaryButton onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

/** Add or rename a column. */
export function ColumnDialog({
  title,
  info,
  initialName = "",
  askKind,
  onSubmit,
  onClose,
}: {
  title: string;
  info: FormatsInfo;
  initialName?: string;
  askKind: boolean;
  onSubmit: (name: string, kind: Kind) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState<Kind>("text");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);

  async function submit() {
    try {
      await onSubmit(name, kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <input
        ref={ref}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Column name"
        className={inputClass}
        style={inputStyle}
      />
      {askKind && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {info.kinds.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium"
              style={{
                borderColor: kind === k.id ? "var(--accent)" : "var(--border)",
                background: kind === k.id ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-xs" style={{ color: "#e11d48" }}>{error}</p>}
      <div className="mt-5 flex justify-end">
        <PrimaryButton onClick={submit}>{askKind ? "Add column" : "Rename"}</PrimaryButton>
      </div>
    </Modal>
  );
}
