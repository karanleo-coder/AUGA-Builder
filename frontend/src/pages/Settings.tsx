import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { swatchFor, COLOR_NAMES } from "../colors";
import { Folder, FolderOpen, Package, RefreshCw, scriptIcon, SCRIPT_ICON_NAMES, Trash2 } from "../icons";
import { useStore } from "../store";
import type { BrowseEntry, ScriptInfo } from "../types";

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SCRIPT_ICON_NAMES.map((name) => {
        const Icon = scriptIcon(name);
        const active = value === name;
        return (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border transition-colors"
            style={{
              borderColor: active ? "var(--accent)" : "var(--border)",
              background: active ? "var(--bg-inset)" : "transparent",
            }}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_NAMES.map((name) => {
        const swatch = swatchFor(name);
        const active = value === name;
        return (
          <button
            key={name}
            type="button"
            onClick={() => onChange(name)}
            className="h-6 w-6 rounded-full border-2 transition-transform"
            style={{
              background: swatch.solid,
              borderColor: active ? "var(--text)" : "transparent",
              transform: active ? "scale(1.1)" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function ScriptEditor({ script, onDeleted }: { script: ScriptInfo; onDeleted: () => void }) {
  const [name, setName] = useState(script.name);
  const [description, setDescription] = useState(script.description);
  const [icon, setIcon] = useState(script.icon);
  const [color, setColor] = useState(script.color);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [deleting, setDeleting] = useState(false);

  async function save() {
    setSaving("saving");
    try {
      await api.updateScript(script.id, { name, description, icon, color });
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 1200);
    } catch {
      setSaving("idle");
    }
  }

  async function remove() {
    if (!confirm(`Remove "${script.name}" from the console? The file itself won't be deleted.`)) return;
    setDeleting(true);
    try {
      await api.deleteScript(script.id);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
            {script.path}
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm font-semibold outline-none focus:ring-2"
            style={{ borderColor: "var(--border)" }}
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Description shown on the dashboard"
            className="mt-2 w-full resize-none rounded-lg border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-2"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          />
        </div>
        <button
          onClick={remove}
          disabled={deleting}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border hover:bg-[var(--bg-inset)] disabled:opacity-50"
          style={{ borderColor: "var(--border)", color: "#fb7185" }}
          title="Remove from console"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="flex gap-6">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              Icon
            </p>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              Color
            </p>
            <ColorPicker value={color} onChange={setColor} />
          </div>
        </div>
        <button
          onClick={save}
          className="rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90"
          style={{ background: "var(--accent)", color: "var(--accent-text)" }}
        >
          {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved ✓" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function FileBrowser({ onPick }: { onPick: (entry: BrowseEntry) => void }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .browse(path)
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [path]);

  const crumbs = path ? path.split("/") : [];

  return (
    <div className="rounded-xl border" style={{ borderColor: "var(--border)" }}>
      <div
        className="flex items-center gap-1 overflow-x-auto border-b px-3 py-2 text-xs"
        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
      >
        <button onClick={() => setPath("")} className="shrink-0 font-medium hover:underline">
          project root
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex shrink-0 items-center gap-1">
            <span style={{ color: "var(--text-faint)" }}>/</span>
            <button
              onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}
              className="font-medium hover:underline"
            >
              {c}
            </button>
          </span>
        ))}
      </div>
      <div className="max-h-64 overflow-y-auto p-1.5">
        {loading && (
          <p className="px-2 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            Loading…
          </p>
        )}
        {!loading && entries.length === 0 && (
          <p className="px-2 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            Empty folder.
          </p>
        )}
        {!loading &&
          entries.map((entry) =>
            entry.is_dir ? (
              <button
                key={entry.path}
                onClick={() => setPath(entry.path)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-inset)]"
              >
                <Folder size={14} style={{ color: "var(--text-faint)" }} />
                {entry.name}
              </button>
            ) : entry.is_python ? (
              <button
                key={entry.path}
                onClick={() => onPick(entry)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-inset)]"
                style={{ color: "var(--accent)" }}
              >
                <FolderOpen size={14} />
                {entry.name}
              </button>
            ) : null,
          )}
      </div>
    </div>
  );
}

function AddScriptPanel({ onAdded }: { onAdded: () => void }) {
  const [picked, setPicked] = useState<BrowseEntry | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("sparkles");
  const [color, setColor] = useState("violet");
  const [saving, setSaving] = useState(false);

  function pick(entry: BrowseEntry) {
    setPicked(entry);
    const base = entry.name.replace(/\.py$/, "").replace(/[_-]/g, " ");
    setName(base.replace(/\b\w/g, (c) => c.toUpperCase()));
  }

  async function add() {
    if (!picked) return;
    setSaving(true);
    try {
      await api.createScript({ path: picked.path, name, description, icon, color });
      setPicked(null);
      setName("");
      setDescription("");
      onAdded();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add script");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
      <p className="mb-3 text-sm font-semibold">Add a script</p>
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        Drop a new <code>.py</code> file anywhere in the project folder, then either{" "}
        <strong>rescan</strong> above to pick it up automatically, or browse for it here to set a
        custom name, icon and color.
      </p>
      <FileBrowser onPick={pick} />

      {picked && (
        <div className="mt-3 animate-fade-in rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
          <p className="mb-2 truncate text-xs" style={{ color: "var(--text-faint)" }}>
            {picked.path}
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-2"
            style={{ borderColor: "var(--border)" }}
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Short description (optional)"
            className="mt-2 w-full resize-none rounded-lg border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-2"
            style={{ borderColor: "var(--border)" }}
          />
          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <div className="flex gap-6">
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                  Icon
                </p>
                <IconPicker value={icon} onChange={setIcon} />
              </div>
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                  Color
                </p>
                <ColorPicker value={color} onChange={setColor} />
              </div>
            </div>
            <button
              onClick={add}
              disabled={saving || !name.trim()}
              className="rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--accent-text)" }}
            >
              {saving ? "Adding…" : "Add to console"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ScriptsFolderCard() {
  const scriptsDir = useStore((s) => s.scriptsDir);
  const packaged = useStore((s) => s.packaged);
  const [error, setError] = useState<string | null>(null);
  if (!scriptsDir) return null;
  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border p-4"
      style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
    >
      <FolderOpen size={20} style={{ color: "var(--accent)" }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Your scripts folder</p>
        <p className="truncate font-mono text-xs" style={{ color: "var(--text-muted)" }} title={scriptsDir}>
          {scriptsDir}
        </p>
        <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
          {packaged
            ? "Put your .py files here (subfolders are fine), then click Rescan for new scripts."
            : "Dev mode: the whole project folder is scanned for .py files."}
        </p>
        {error && <p className="mt-1 text-xs" style={{ color: "#fb7185" }}>{error}</p>}
      </div>
      <button
        onClick={() => {
          setError(null);
          api.openScriptsFolder().catch((e) => setError(e instanceof Error ? e.message : String(e)));
        }}
        className="rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
        style={{ background: "var(--accent)", color: "var(--accent-text)" }}
      >
        Open folder
      </button>
    </div>
  );
}

function InstallPackagesCard() {
  const installPackages = useStore((s) => s.installPackages);
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function install() {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const run = await installPackages(value.trim());
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-6 rounded-2xl border p-4"
      style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
    >
      <p className="text-sm font-semibold">Install a Python package</p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
        If a script says <span className="font-mono">No module named …</span>, install that package here. Separate
        several with spaces.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && install()}
          placeholder="e.g. openpyxl   or   numpy==2.1"
          className="flex-1 rounded-lg border bg-transparent px-3 py-2 font-mono text-sm outline-none focus:ring-2"
          style={{ borderColor: "var(--border)" }}
        />
        <button
          onClick={install}
          disabled={busy || !value.trim()}
          className="flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-text)" }}
        >
          <Package size={14} />
          {busy ? "Starting…" : "Install"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs" style={{ color: "#fb7185" }}>{error}</p>}
    </div>
  );
}

export function Settings() {
  const scripts = useStore((s) => s.scripts);
  const loadScripts = useStore((s) => s.loadScripts);
  const [rescanning, setRescanning] = useState(false);

  async function rescan() {
    setRescanning(true);
    try {
      await useStore.getState().rescanScripts();
    } finally {
      setRescanning(false);
    }
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            Manage which scripts show up in the sidebar and dashboard.
          </p>
        </div>
        <button
          onClick={rescan}
          disabled={rescanning}
          className="flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium hover:bg-[var(--bg-inset)] disabled:opacity-60"
          style={{ borderColor: "var(--border)" }}
        >
          <RefreshCw size={14} className={rescanning ? "animate-spin-slow" : ""} />
          Rescan for new scripts
        </button>
      </header>

      <ScriptsFolderCard />
      <InstallPackagesCard />

      <div className="mb-8 flex flex-col gap-3">
        {scripts.map((script) => (
          <ScriptEditor key={script.id} script={script} onDeleted={loadScripts} />
        ))}
        {scripts.length === 0 && (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No scripts registered yet.
          </p>
        )}
      </div>

      <AddScriptPanel onAdded={loadScripts} />
    </div>
  );
}
