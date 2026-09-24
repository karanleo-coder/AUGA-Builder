import { useNavigate } from "react-router-dom";
import { swatchFor } from "../colors";
import { Check, RefreshCw, scriptIcon, X } from "../icons";
import type { RunSummary } from "../types";

function elapsed(run: RunSummary): string {
  const end = run.ended_at ?? Date.now() / 1000;
  const secs = Math.max(0, Math.round(end - run.started_at));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

const STATUS_LABEL: Record<RunSummary["status"], string> = {
  running: "Running",
  awaiting_input: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  killed: "Stopped",
};

export function RunRing({ run, size = 84 }: { run: RunSummary; size?: number }) {
  const navigate = useNavigate();
  const swatch = swatchFor(run.color);
  const Icon = scriptIcon(run.icon);
  const stroke = Math.max(3, Math.round(size * 0.055));
  const radius = size / 2 - stroke;
  const circumference = 2 * Math.PI * radius;

  const isActive = run.status === "running" || run.status === "awaiting_input";
  const isDeterminate = isActive && run.progress != null;
  const dashOffset = isDeterminate ? circumference * (1 - (run.progress ?? 0) / 100) : 0;

  const ringColor =
    run.status === "failed" ? "#fb7185" : run.status === "killed" ? "#8a8a94" : swatch.solid;

  return (
    <button
      onClick={() => navigate(`/runs/${run.id}`)}
      className="group relative flex flex-col items-center gap-2 rounded-2xl p-2 transition-transform hover:scale-[1.04] active:scale-[0.98] cursor-pointer"
      style={{ width: size + 24 }}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className={isActive && !isDeterminate ? "animate-spin-slow" : ""}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--ring-track)"
            strokeWidth={stroke}
          />
          {isActive && isDeterminate && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={ringColor}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: "stroke-dashoffset 0.5s ease" }}
            />
          )}
          {isActive && !isDeterminate && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={ringColor}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${circumference * 0.28} ${circumference}`}
            />
          )}
          {!isActive && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={ringColor}
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeDashoffset={0}
            />
          )}
        </svg>
        <div
          className="absolute inset-0 flex items-center justify-center rounded-full"
          style={{ background: swatch.soft }}
        >
          {run.status === "completed" ? (
            <Check size={size * 0.34} color={ringColor} strokeWidth={2.5} />
          ) : run.status === "failed" ? (
            <X size={size * 0.34} color={ringColor} strokeWidth={2.5} />
          ) : run.status === "killed" ? (
            <Icon size={size * 0.32} color="#8a8a94" strokeWidth={2} />
          ) : (
            <Icon size={size * 0.32} color={swatch.text} strokeWidth={2} />
          )}
        </div>
        {run.status === "awaiting_input" && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2"
            style={{ background: "#fbbf24", boxShadow: "0 0 0 2px var(--bg-elevated)" }}
          >
            <RefreshCw size={9} color="#3a2c00" />
          </span>
        )}
      </div>

      <span
        className="max-w-[9rem] truncate text-xs font-medium"
        style={{ color: "var(--text)" }}
      >
        {run.script_name}
      </span>

      {/* Hover tooltip */}
      <div
        className="pointer-events-none absolute -top-2 left-1/2 z-20 w-52 -translate-x-1/2 -translate-y-full rounded-xl border p-3 text-left opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
            {run.script_name}
          </span>
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: swatch.soft, color: swatch.text }}
          >
            {STATUS_LABEL[run.status]}
          </span>
        </div>
        <p className="mt-1 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
          {run.awaiting_prompt ? `Waiting: ${run.awaiting_prompt}` : run.last_line || "Starting…"}
        </p>
        <p className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }}>
          {elapsed(run)} elapsed{run.progress != null ? ` · ${Math.round(run.progress)}%` : ""}
        </p>
      </div>
    </button>
  );
}
