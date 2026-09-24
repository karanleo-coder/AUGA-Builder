import { useEffect, useRef, useState } from "react";
import { Send } from "../icons";
import type { LogLine, RunStatus } from "../types";

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [log, stickToBottom]);

  useEffect(() => {
    if (status === "awaiting_input") inputRef.current?.focus();
  }, [status, awaitingPrompt]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStickToBottom(atBottom);
  }

  function submit() {
    if (disabled) return;
    onSend(draft);
    setDraft("");
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
        {log.map((line) => {
          const st = lineStyle(line.stream);
          return (
            <div key={line.seq} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="shrink-0 select-none opacity-40" style={{ fontSize: "10.5px" }}>
                {formatTime(line.ts)}
              </span>
              <span style={{ color: st.color, fontStyle: st.italic ? "italic" : undefined }}>
                {st.prefix}
                {line.text || " "}
              </span>
            </div>
          );
        })}
        {isRunning && status === "running" && (
          <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-blink" style={{ background: "var(--text-faint)" }} />
        )}
      </div>

      <div className="border-t px-3 py-3" style={{ borderColor: "var(--border)" }}>
        {status === "awaiting_input" ? (
          <div className="animate-fade-in">
            <p className="mb-1.5 truncate text-[11px] font-medium" style={{ color: "var(--accent)" }}>
              {awaitingPrompt || "Waiting for your input…"}
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type={isSecret ? "password" : "text"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Type your answer and press Enter…"
                className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
                style={{
                  background: "var(--bg-elevated)",
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              />
              <button
                onClick={submit}
                className="flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
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
