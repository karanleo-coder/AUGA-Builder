import { create } from "zustand";
import { api, connectRunStream } from "./api";
import type { LogLine, RunSummary, ScriptInfo, StreamEvent } from "./types";

const MAX_BUFFERED_LINES = 800;
const ACTIVE_STATUSES = new Set(["running", "awaiting_input"]);

// Live WebSocket connections live outside React state — they're an
// implementation detail of keeping the store in sync, not UI state.
const sockets = new Map<string, ReturnType<typeof connectRunStream>>();

interface RunsState {
  scripts: ScriptInfo[];
  scriptsLoaded: boolean;
  runs: Record<string, RunSummary>;
  logs: Record<string, LogLine[]>;
  runOrder: string[]; // most-recently-started first

  loadScripts: () => Promise<void>;
  rescanScripts: () => Promise<void>;
  loadRuns: () => Promise<void>;
  startRun: (scriptId: string) => Promise<RunSummary>;
  ensureLive: (runId: string) => void;
  sendInput: (runId: string, text: string) => void;
  killRun: (runId: string) => void;
  hydrateFullLog: (runId: string) => Promise<void>;
}

function applyEvent(
  runId: string,
  event: StreamEvent,
  set: (fn: (s: RunsState) => Partial<RunsState>) => void,
) {
  set((s) => {
    switch (event.type) {
      case "snapshot": {
        const { log, ...summary } = event.run;
        return {
          runs: { ...s.runs, [runId]: summary },
          logs: { ...s.logs, [runId]: log.slice(-MAX_BUFFERED_LINES) },
        };
      }
      case "log":
      case "input": {
        const existing = s.logs[runId] ?? [];
        const nextLog = [...existing, event.line].slice(-MAX_BUFFERED_LINES);
        const current = s.runs[runId];
        const patch: Partial<RunSummary> = { last_line: event.line.text.trim() || current?.last_line };
        if (event.type === "input" && "status" in event) patch.status = event.status;
        return {
          logs: { ...s.logs, [runId]: nextLog },
          runs: current ? { ...s.runs, [runId]: { ...current, ...patch } } : s.runs,
        };
      }
      case "prompt": {
        const current = s.runs[runId];
        return current
          ? { runs: { ...s.runs, [runId]: { ...current, awaiting_prompt: event.text, status: "awaiting_input" } } }
          : {};
      }
      case "status": {
        const current = s.runs[runId];
        if (!current) return {};
        return {
          runs: {
            ...s.runs,
            [runId]: {
              ...current,
              status: event.status,
              exit_code: event.exit_code ?? current.exit_code,
              awaiting_prompt: ACTIVE_STATUSES.has(event.status) ? current.awaiting_prompt : null,
            },
          },
        };
      }
      case "done": {
        const sock = sockets.get(runId);
        if (sock) {
          sock.close();
          sockets.delete(runId);
        }
        return {};
      }
      default:
        return {};
    }
  });
}

export const useStore = create<RunsState>((set, get) => ({
  scripts: [],
  scriptsLoaded: false,
  runs: {},
  logs: {},
  runOrder: [],

  loadScripts: async () => {
    const scripts = await api.listScripts();
    set({ scripts, scriptsLoaded: true });
  },

  rescanScripts: async () => {
    const scripts = await api.rescanScripts();
    set({ scripts });
  },

  loadRuns: async () => {
    const runs = await api.listRuns();
    set((s) => {
      const map = { ...s.runs };
      const order = [...s.runOrder];
      for (const r of runs) {
        if (!map[r.id]) order.push(r.id);
        map[r.id] = r;
      }
      order.sort((a, b) => (map[b]?.started_at ?? 0) - (map[a]?.started_at ?? 0));
      return { runs: map, runOrder: order };
    });
    for (const r of runs) {
      if (ACTIVE_STATUSES.has(r.status)) get().ensureLive(r.id);
    }
  },

  startRun: async (scriptId: string) => {
    const run = await api.startRun(scriptId);
    set((s) => ({
      runs: { ...s.runs, [run.id]: run },
      runOrder: [run.id, ...s.runOrder],
    }));
    get().ensureLive(run.id);
    return run;
  },

  ensureLive: (runId: string) => {
    if (sockets.has(runId)) return;
    const sock = connectRunStream(runId, (event) => applyEvent(runId, event, set));
    sockets.set(runId, sock);
  },

  sendInput: (runId: string, text: string) => {
    get().ensureLive(runId);
    sockets.get(runId)?.send(text);
  },

  killRun: (runId: string) => {
    sockets.get(runId)?.kill() ?? api.killRun(runId).catch(() => {});
  },

  hydrateFullLog: async (runId: string) => {
    const detail = await api.getRun(runId);
    set((s) => ({
      runs: { ...s.runs, [runId]: detail },
      logs: { ...s.logs, [runId]: detail.log.slice(-MAX_BUFFERED_LINES) },
      runOrder: s.runOrder.includes(runId) ? s.runOrder : [runId, ...s.runOrder],
    }));
    if (ACTIVE_STATUSES.has(detail.status)) get().ensureLive(runId);
  },
}));

export function scriptById(scripts: ScriptInfo[], id: string): ScriptInfo | undefined {
  return scripts.find((s) => s.id === id);
}
