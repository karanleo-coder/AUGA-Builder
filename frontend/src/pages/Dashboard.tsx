import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { swatchFor } from "../colors";
import { RunRing } from "../components/RunRing";
import { Play, Plus, scriptIcon, Table2 } from "../icons";
import { useStore } from "../store";

export function Dashboard() {
  const scripts = useStore((s) => s.scripts);
  const runs = useStore((s) => s.runs);
  const runOrder = useStore((s) => s.runOrder);
  const startRun = useStore((s) => s.startRun);
  const editorFile = useStore((s) => s.editorFile);
  const navigate = useNavigate();
  const [launching, setLaunching] = useState<string | null>(null);

  const allRuns = useMemo(() => runOrder.map((id) => runs[id]).filter(Boolean), [runOrder, runs]);
  const active = allRuns.filter((r) => r.status === "running" || r.status === "awaiting_input");
  const recent = allRuns.filter((r) => r.status !== "running" && r.status !== "awaiting_input").slice(0, 12);

  async function handleLaunch(scriptId: string) {
    setLaunching(scriptId);
    try {
      const run = await startRun(scriptId);
      navigate(`/runs/${run.id}`);
    } finally {
      setLaunching(null);
    }
  }

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-6 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          {active.length > 0
            ? `${active.length} script${active.length === 1 ? "" : "s"} running right now.`
            : "Nothing running. Launch a script below."}
        </p>
      </header>

      <button
        onClick={() => navigate("/editor")}
        className="mb-10 flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-shadow hover:shadow-md"
        style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ background: "color-mix(in srgb, #22d3ee 15%, transparent)" }}
        >
          <Table2 size={22} color="#0891b2" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Data Editor</span>
          <span className="block text-xs" style={{ color: "var(--text-muted)" }}>
            {editorFile
              ? `${editorFile.name} is open${editorFile.dirty ? " (unsaved changes)" : ""}`
              : "Open Parquet, Arrow, JSON, JSONL or CSV files and edit them like a spreadsheet."}
          </span>
        </span>
        <span className="shrink-0 text-xs font-semibold" style={{ color: "var(--accent)" }}>
          {editorFile ? "Continue →" : "Open →"}
        </span>
      </button>

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-semibold" style={{ color: "var(--text-muted)" }}>
          Running now
        </h2>
        {active.length === 0 ? (
          <div
            className="rounded-2xl border border-dashed px-6 py-8 text-center text-sm"
            style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
          >
            No active processes. Start one from the list below — you can run several at once.
          </div>
        ) : (
          <div className="flex flex-wrap gap-5">
            {active.map((run) => (
              <RunRing key={run.id} run={run} size={92} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-muted)" }}>
            Launch a script
          </h2>
          <button
            onClick={() => navigate("/settings")}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-inset)]"
            style={{ borderColor: "var(--border)" }}
          >
            <Plus size={13} />
            Add scripts
          </button>
        </div>
        {scripts.length === 0 ? (
          <div
            className="rounded-2xl border border-dashed px-6 py-8 text-center text-sm"
            style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
          >
            No scripts registered yet. Go to Settings to add one.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scripts.map((script) => {
              const swatch = swatchFor(script.color);
              const Icon = scriptIcon(script.icon);
              return (
                <div
                  key={script.id}
                  className="group flex flex-col rounded-2xl border p-4 transition-shadow hover:shadow-md"
                  style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                      style={{ background: swatch.soft }}
                    >
                      <Icon size={18} color={swatch.text} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{script.name}</p>
                      <p className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
                        {script.folder}
                      </p>
                    </div>
                  </div>
                  <p
                    className="mt-2 line-clamp-2 flex-1 text-xs leading-relaxed"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {script.description || "No description yet."}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => handleLaunch(script.id)}
                      disabled={launching === script.id}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
                      style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                    >
                      <Play size={12} />
                      {launching === script.id ? "Starting…" : "Run"}
                    </button>
                    <button
                      onClick={() => navigate(`/scripts/${script.id}`)}
                      className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-inset)]"
                      style={{ borderColor: "var(--border)" }}
                    >
                      Details
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-semibold" style={{ color: "var(--text-muted)" }}>
            Recent runs
          </h2>
          <div className="flex flex-wrap gap-5">
            {recent.map((run) => (
              <RunRing key={run.id} run={run} size={72} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
