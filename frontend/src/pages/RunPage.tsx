import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { swatchFor } from "../colors";
import { Console } from "../components/Console";
import { scriptIcon, Square } from "../icons";
import { useStore } from "../store";
import type { LogLine } from "../types";

// Stable reference so the zustand selector below never hands React a
// freshly-allocated array on renders where this run has no log yet.
const EMPTY_LOG: LogLine[] = [];

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  awaiting_input: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  killed: "Stopped",
};

function elapsed(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now() / 1000;
  const secs = Math.max(0, Math.round(end - startedAt));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const run = useStore((s) => (runId ? s.runs[runId] : undefined));
  const log = useStore((s) => (runId ? s.logs[runId] : undefined)) ?? EMPTY_LOG;
  const hydrateFullLog = useStore((s) => s.hydrateFullLog);
  const sendInput = useStore((s) => s.sendInput);
  const killRun = useStore((s) => s.killRun);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (runId) hydrateFullLog(runId);
  }, [runId, hydrateFullLog]);

  // re-render every second to keep the elapsed-time readout live
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!runId) return null;

  if (!run) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 text-sm" style={{ color: "var(--text-muted)" }}>
        Loading run…
      </div>
    );
  }

  const swatch = swatchFor(run.color);
  const Icon = scriptIcon(run.icon);
  const isActive = run.status === "running" || run.status === "awaiting_input";

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-6 py-8">
      <div className="mb-5 flex items-start gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ background: swatch.soft }}
        >
          <Icon size={22} color={swatch.text} />
        </span>
        <div className="min-w-0 flex-1">
          {run.script_id.startsWith("__") ? (
            <span className="text-lg font-semibold">{run.script_name}</span>
          ) : (
            <Link
              to={`/scripts/${run.script_id}`}
              className="text-lg font-semibold hover:underline"
              style={{ color: "var(--text)" }}
            >
              {run.script_name}
            </Link>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
            <span
              className="rounded-full px-2 py-0.5 font-medium"
              style={{ background: swatch.soft, color: swatch.text }}
            >
              {STATUS_LABEL[run.status] ?? run.status}
            </span>
            <span key={tick}>{elapsed(run.started_at, run.ended_at)} elapsed</span>
            {run.progress != null && isActive && <span>{Math.round(run.progress)}% complete</span>}
            {run.exit_code != null && <span>exit code {run.exit_code}</span>}
          </div>
        </div>
        {isActive && (
          <button
            onClick={() => runId && killRun(runId)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-medium hover:bg-[var(--bg-inset)]"
            style={{ borderColor: "var(--border)", color: "#fb7185" }}
          >
            <Square size={13} />
            Stop
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <Console
          log={log}
          status={run.status}
          awaitingPrompt={run.awaiting_prompt}
          onSend={(text) => sendInput(runId, text)}
          disabled={run.status !== "awaiting_input"}
        />
      </div>
    </div>
  );
}
