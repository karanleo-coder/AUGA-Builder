import type { BrowseEntry, RunDetail, RunSummary, ScriptInfo, StreamEvent } from "./types";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.detail ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listScripts: () => fetch("/api/scripts").then((r) => j<ScriptInfo[]>(r)),
  getScript: (id: string) => fetch(`/api/scripts/${id}`).then((r) => j<ScriptInfo>(r)),
  getScriptSource: (id: string) =>
    fetch(`/api/scripts/${id}/source`).then((r) => j<{ source: string }>(r)),
  rescanScripts: () => fetch("/api/scripts/rescan", { method: "POST" }).then((r) => j<ScriptInfo[]>(r)),
  browse: (path: string) =>
    fetch(`/api/scripts/browse?path=${encodeURIComponent(path)}`).then((r) => j<BrowseEntry[]>(r)),
  createScript: (payload: {
    path: string;
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
  }) =>
    fetch("/api/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => j<ScriptInfo>(r)),
  updateScript: (
    id: string,
    payload: Partial<Pick<ScriptInfo, "name" | "description" | "icon" | "color">>,
  ) =>
    fetch(`/api/scripts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => j<ScriptInfo>(r)),
  deleteScript: (id: string) => fetch(`/api/scripts/${id}`, { method: "DELETE" }).then((r) => j(r)),

  listRuns: () => fetch("/api/runs").then((r) => j<RunSummary[]>(r)),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then((r) => j<RunDetail>(r)),
  startRun: (scriptId: string) =>
    fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script_id: scriptId }),
    }).then((r) => j<RunSummary>(r)),
  sendInput: (runId: string, text: string) =>
    fetch(`/api/runs/${runId}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => j(r)),
  killRun: (runId: string) => fetch(`/api/runs/${runId}/kill`, { method: "POST" }).then((r) => j(r)),
};

export function connectRunStream(
  runId: string,
  onEvent: (event: StreamEvent) => void,
): { send: (text: string) => void; kill: () => void; close: () => void } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/runs/${runId}/stream`);

  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      /* ignore malformed frame */
    }
  };

  return {
    send: (text: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", text }));
      } else {
        // fall back to REST if the socket isn't ready
        api.sendInput(runId, text).catch(() => {});
      }
    },
    kill: () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "kill" }));
      } else {
        api.killRun(runId).catch(() => {});
      }
    },
    close: () => ws.close(),
  };
}
