export type RunStatus =
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "killed";

export interface ScriptInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  folder: string;
  icon: string;
  color: string;
  created_at: number;
}

export interface LogLine {
  seq: number;
  ts: number;
  text: string;
  stream: "out" | "err" | "system" | "in" | "ui";
}

export interface RunSummary {
  id: string;
  script_id: string;
  script_name: string;
  icon: string;
  color: string;
  status: RunStatus;
  started_at: number;
  ended_at: number | null;
  progress: number | null;
  last_line: string;
  awaiting_prompt: string | null;
  exit_code: number | null;
}

export interface RunDetail extends RunSummary {
  log: LogLine[];
}

export interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_python: boolean;
}

export type StreamEvent =
  | { type: "snapshot"; run: RunDetail }
  | { type: "log"; line: LogLine }
  | { type: "prompt"; text: string; line: LogLine }
  | { type: "status"; status: RunStatus; exit_code?: number | null }
  | { type: "input"; line: LogLine; status: RunStatus }
  | { type: "progress"; value: number | null }
  | { type: "done" }
  | { type: "error"; message: string };
