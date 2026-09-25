import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { FolderOpen, Send } from "../icons";
import { useStore } from "../store";
import type { LogLine, RunStatus } from "../types";

// ---- rich output from scripts that use auga_ui.py ----------------------------

type Cell = string | number | boolean | null;
interface UiTable {
  type: "table";
  title?: string | null;
  columns: string[];
  dtypes?: string[] | null;
  rows: Cell[][];
  row_numbers?: number[];
  total_rows?: number;
  truncated?: boolean;
}
interface UiMessage {
  type: "message";
  text: string;
  kind?: "info" | "success" | "warning" | "error";
}
interface UiChoices {
  type: "choices";
  options: { value: string; label: string }[];
  default?: string | null;
}
interface UiAskPath {
  type: "ask_path";
  kind: "open" | "save" | "folder";
  extensions?: string[];
  default_name?: string | null;
}
type UiEvent = UiTable | UiMessage | UiChoices | UiAskPath;

function parseUi(line: LogLine): UiEvent | null {
  if (line.stream !== "ui") return null;
  try {
    return JSON.parse(line.text) as UiEvent;
  } catch {
    return null;
  }
}

const MESSAGE_STYLE: Record<string, { bg: string; fg: string; icon: string }> = {
  info: { bg: "color-mix(in srgb, var(--accent) 10%, transparent)", fg: "var(--text)", icon: "•" },
  success: { bg: "rgba(34,197,94,0.12)", fg: "#16a34a", icon: "✔" },
  warning: { bg: "rgba(245,158,11,0.14)", fg: "#b45309", icon: "!" },
  error: { bg: "rgba(244,63,94,0.12)", fg: "#e11d48", icon: "✖" },
};

function Message({ ev }: { ev: UiMessage }) {
  const st = MESSAGE_STYLE[ev.kind ?? "info"] ?? MESSAGE_STYLE.info;
  return (
    <div
      className="my-1.5 flex gap-2 rounded-lg px-3 py-2 font-sans text-[13px]"
      style={{ background: st.bg, color: st.fg }}
    >
      <span className="font-semibold">{st.icon}</span>
      <span className="whitespace-pre-wrap break-words" style={{ color: ev.kind === "info" ? "var(--text)" : st.fg }}>
        {ev.text}
      </span>
    </div>
  );
}

function isNumeric(dtype?: string) {
  return !!dtype && /int|float|decimal|double/i.test(dtype);
}

function DataTable({ ev }: { ev: UiTable }) {
  const numbers = ev.row_numbers ?? ev.rows.map((_, i) => i + 1);
  return (
    <div className="my-2 overflow-hidden rounded-xl border font-sans" style={{ borderColor: "var(--border)" }}>
      {(ev.title || ev.truncated) && (
        <div
          className="flex items-center justify-between gap-3 border-b px-3 py-2 text-xs font-semibold"
          style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
        >
          <span>{ev.title}</span>
          {ev.truncated && (
            <span className="font-normal" style={{ color: "var(--text-faint)" }}>
              showing the first {ev.rows.length.toLocaleString()} rows
            </span>
          )}
        </div>
      )}
      <div className="max-h-[420px] overflow-auto" style={{ background: "var(--bg-elevated)" }}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-10" style={{ background: "var(--bg-inset)" }}>
            <tr>
              <th className="px-3 py-1.5 text-right font-medium" style={{ color: "var(--text-faint)" }}>
                #
              </th>
              {ev.columns.map((c, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-1.5 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ev.rows.map((row, r) => (
              <tr key={r} className="border-t hover:bg-[var(--bg-inset)]" style={{ borderColor: "var(--border)" }}>
                <td className="px-3 py-1 text-right tabular-nums" style={{ color: "var(--text-faint)" }}>
                  {numbers[r]}
                </td>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={`max-w-[320px] truncate px-3 py-1 ${isNumeric(ev.dtypes?.[c]) || typeof cell === "number" ? "text-right tabular-nums" : ""}`}
                    title={cell === null ? "empty" : String(cell)}
                  >
                    {cell === null ? (
                      <span style={{ color: "var(--text-faint)" }}>—</span>
                    ) : typeof cell === "boolean" ? (
                      cell ? "Yes" : "No"
                    ) : (
                      String(cell)
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {ev.rows.length === 0 && (
              <tr>
                <td
                  colSpan={ev.columns.length + 1}
                  className="px-3 py-3 text-center"
                  style={{ color: "var(--text-faint)" }}
                >
                  No rows yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- plain lines ----------------------------------------------------------------

function lineStyle(stream: LogLine["stream"]): { color: string; prefix?: string; italic?: boolean } {
  switch (stream) {
    case "err":
      return { color: "#fb7185" };
    case "system":
      return { color: "var(--text-faint)", italic: true };
    case "in":
      return { color: "var(--accent)", prefix: "› " };
    default:
      return { color: "var(--text)" };
  }
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
}

const SECRET_HINT = /password|token|secret|hidden|api[\s_-]?key/i;

export function Console({
  log,
  status,
  awaitingPrompt,
  onSend,
  disabled,
}: {
  log: LogLine[];
  status: RunStatus;
  awaitingPrompt: string | null;
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const nativeDialogs = useStore((s) => s.nativeDialogs);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [draft, setDraft] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each line, parsed; an answer to a choice question shows the option's
  // label ("Find rows") rather than the value sent to the script ("find").
  const parsed = useMemo(() => {
    let choices: UiChoices | null = null;
    return log.map((line) => {
      const ui = parseUi(line);
      if (ui?.type === "choices") choices = ui;
      let label: string | undefined;
      if (line.stream === "in") {
        label = choices?.options.find((o) => o.value === line.text)?.label;
        choices = null;
      }
      return { line, ui, label };
    });
  }, [log]);

  // The script's hint for the question it's asking now (buttons or Browse):
  // the latest choices/ask_path since the last answer.
  const hint = useMemo(() => {
    if (status !== "awaiting_input") return null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      const { line, ui } = parsed[i];
      if (line.stream === "in") return null;
      if (ui && (ui.type === "choices" || ui.type === "ask_path")) return ui;
    }
    return null;
  }, [parsed, status]);

  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [log, stickToBottom, hint]);

  useEffect(() => {
    if (status === "awaiting_input") inputRef.current?.focus();
  }, [status, awaitingPrompt]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStickToBottom(atBottom);
  }

  function send(text: string) {
    if (disabled) return;
    onSend(text);
    setDraft("");
  }

  async function browse(ask: UiAskPath) {
    setBrowsing(true);
    try {
      const res = await api.pickPath(ask.kind, ask.extensions ?? [], ask.default_name ?? null);
      if (res.path) send(res.path);
    } finally {
      setBrowsing(false);
    }
  }

  const isSecret = awaitingPrompt ? SECRET_HINT.test(awaitingPrompt) : false;
  const isRunning = status === "running" || status === "awaiting_input";

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-2xl border"
      style={{ borderColor: "var(--border)", background: "var(--bg-inset)" }}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed"
      >
        {log.length === 0 && (
          <p style={{ color: "var(--text-faint)" }} className="italic">
            Waiting for output…
          </p>
        )}
        {parsed.map(({ line, ui, label }) => {
          if (ui) {
            if (ui.type === "table") return <DataTable key={line.seq} ev={ui} />;
            if (ui.type === "message") return <Message key={line.seq} ev={ui} />;
            return null; // choices / ask_path show up in the answer bar
          }
          if (line.stream === "ui") return null;
          const st = lineStyle(line.stream);
          return (
            <div key={line.seq} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 select-none opacity-40" style={{ fontSize: "10.5px" }}>
                {formatTime(line.ts)}
              </span>
              <span style={{ color: st.color, fontStyle: st.italic ? "italic" : undefined }}>
                {st.prefix}
                {label ?? (line.text || " ")}
              </span>
            </div>
          );
        })}
        {isRunning && status === "running" && (
          <span
            className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-blink"
            style={{ background: "var(--text-faint)" }}
          />
        )}
      </div>

      <div className="border-t px-3 py-3" style={{ borderColor: "var(--border)" }}>
        {status === "awaiting_input" ? (
          <div className="animate-fade-in">
            <p className="mb-2 truncate text-[12px] font-medium" style={{ color: "var(--accent)" }}>
              {awaitingPrompt || "Waiting for your input…"}
            </p>

            {hint?.type === "choices" && (
              <div className="mb-2.5 flex max-h-44 flex-wrap gap-2 overflow-y-auto">
                {hint.options.map((opt) => {
                  const isDefault = hint.default != null && opt.value === hint.default;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => send(opt.value)}
                      className="rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--bg-inset)]"
                      style={{
                        borderColor: isDefault ? "var(--accent)" : "var(--border)",
                        background: isDefault ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-elevated)",
                        color: "var(--text)",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type={isSecret ? "password" : "text"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send(draft)}
                placeholder={
                  hint?.type === "choices"
                    ? "…or type your answer and press Enter"
                    : hint?.type === "ask_path"
                      ? "Type a path, or press Enter to use the one in brackets"
                      : "Type your answer and press Enter…"
                }
                className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
                style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text)" }}
              />
              {hint?.type === "ask_path" && nativeDialogs && (
                <button
                  onClick={() => browse(hint)}
                  disabled={browsing}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-[var(--bg-inset)] disabled:opacity-50"
                  style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
                >
                  <FolderOpen size={14} />
                  {browsing ? "Choosing…" : hint.kind === "save" ? "Choose where…" : "Browse…"}
                </button>
              )}
              <button
                onClick={() => send(draft)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                style={{ background: "var(--accent)", color: "var(--accent-text)" }}
              >
                <Send size={14} />
                Send
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            {status === "running"
              ? "Script is running…"
              : status === "completed"
                ? "Finished successfully."
                : status === "failed"
                  ? "Finished with an error."
                  : "Stopped."}
          </p>
        )}
      </div>
    </div>
  );
}
