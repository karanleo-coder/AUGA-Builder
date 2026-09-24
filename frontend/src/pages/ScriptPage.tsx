import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { swatchFor } from "../colors";
import { RunRing } from "../components/RunRing";
import { ChevronRight, Play, scriptIcon } from "../icons";
import { useStore } from "../store";

export function ScriptPage() {
  const { scriptId } = useParams<{ scriptId: string }>();
  const navigate = useNavigate();
  const scripts = useStore((s) => s.scripts);
  const runs = useStore((s) => s.runs);
  const runOrder = useStore((s) => s.runOrder);
  const startRun = useStore((s) => s.startRun);

  const script = scripts.find((s) => s.id === scriptId);
  const [launching, setLaunching] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const scriptRuns = useMemo(
    () => runOrder.map((id) => runs[id]).filter((r) => r && r.script_id === scriptId),
    [runOrder, runs, scriptId],
  );

  useEffect(() => {
    setSource(null);
    setShowSource(false);
  }, [scriptId]);

  useEffect(() => {
    if (showSource && source === null && scriptId) {
      api.getScriptSource(scriptId).then((r) => setSource(r.source));
    }
  }, [showSource, source, scriptId]);

  if (!script) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-sm" style={{ color: "var(--text-muted)" }}>
        Script not found.
      </div>
    );
  }

  const swatch = swatchFor(script.color);
  const Icon = scriptIcon(script.icon);

  async function handleLaunch() {
    setLaunching(true);
    try {
      const run = await startRun(script!.id);
      navigate(`/runs/${run.id}`);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-6 py-8">
      <div className="flex items-start gap-4">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
          style={{ background: swatch.soft }}
        >
          <Icon size={24} color={swatch.text} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{script.name}</h1>
          <p className="text-xs" style={{ color: "var(--text-faint)" }}>
            {script.folder} · {script.path}
          </p>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {script.description || "No description available."}
          </p>
        </div>
        <button
          onClick={handleLaunch}
          disabled={launching}
          className="flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
          style={{ background: "var(--accent)", color: "var(--accent-text)" }}
        >
          <Play size={14} />
          {launching ? "Starting…" : "Run script"}
        </button>
      </div>

      <div className="mt-8">
        <button
          onClick={() => setShowSource((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium"
          style={{ color: "var(--text-muted)" }}
        >
          <ChevronRight size={14} className={showSource ? "rotate-90 transition-transform" : "transition-transform"} />
          {showSource ? "Hide source" : "View source"}
        </button>
        {showSource && (
          <pre
            className="mt-3 max-h-96 overflow-auto rounded-xl border p-4 font-mono text-[11.5px] leading-relaxed"
            style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}
          >
            {source ?? "Loading…"}
          </pre>
        )}
      </div>

      <div className="mt-10">
        <h2 className="mb-4 text-sm font-semibold" style={{ color: "var(--text-muted)" }}>
          Runs of this script
        </h2>
        {scriptRuns.length === 0 ? (
          <div
            className="rounded-2xl border border-dashed px-6 py-8 text-center text-sm"
            style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
          >
            No runs yet. Click "Run script" to start one.
          </div>
        ) : (
          <div className="flex flex-wrap gap-5">
            {scriptRuns.map((run) => (
              <RunRing key={run.id} run={run} size={80} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
