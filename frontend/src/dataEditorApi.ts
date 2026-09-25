/** Client for the Data Editor (backend/data_editor.py). */

export type FormatId = "parquet" | "arrow" | "json" | "jsonl" | "csv";
export type Kind = "text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "other";
export type Cell = string | number | boolean | null;

export interface EditorColumn {
  name: string;
  kind: Kind;
  label: string;
  arrow_type: string;
}

export interface EditorMeta {
  id: string;
  path: string | null;
  name: string;
  format: FormatId;
  file_format: FormatId | null;
  dirty: boolean;
  total_rows: number;
  columns: EditorColumn[];
  can_undo: boolean;
}

export interface FormatsInfo {
  formats: { id: FormatId; label: string; ext: string }[];
  kinds: { id: Kind; label: string }[];
  files_dir: string;
}

export interface RecentFile {
  path: string;
  name: string;
  format: FormatId;
  folder: string;
}

/** Clean data > Duplicate rows: groups of matching rows, most complete first. */
export interface DuplicateResult {
  columns: number[];
  total_groups: number;
  /** how many rows are suggested for removal, over all groups */
  suggested_count: number;
  offset: number;
  /** `size` rows match; the first few are shown, the most complete first */
  groups: { size: number; rows: { i: number; values: Cell[]; filled: number; of: number; keep: boolean }[] }[];
}

export type MatchMode = "contains" | "word" | "exact" | "starts";

/** Clean data > Find by keyword: the rows where the text was found. */
export interface FindResult {
  columns: number[];
  total_rows: number;
  total_cells: number;
  offset: number;
  rows: { i: number; values: Cell[]; matched: number[] }[];
}

/**
 * Which rows a Clean data action applies to, without listing them all: the
 * search, whether its rows start ticked ("suggested" / "all") or not
 * ("none"), and the rows ticked or unticked by hand.
 */
export interface CleanSelection {
  tool: "duplicates" | "find";
  base: "suggested" | "all" | "none";
  add: number[];
  skip: number[];
  cols: number[];
  ignore_case?: boolean;
  text?: string;
  match?: MatchMode;
  case_sensitive?: boolean;
}

export class FileExists extends Error {
  path: string;
  constructor(message: string, path: string) {
    super(message);
    this.path = path;
  }
}

async function handle<T>(res: Response): Promise<T> {
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  if (res.status === 409 && body.exists) throw new FileExists(String(body.detail), String(body.exists));
  if (!res.ok) throw new Error(String(body.detail ?? res.statusText));
  return body as T;
}

const post = <T,>(url: string, data: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(
    (r) => handle<T>(r),
  );

export const dataApi = {
  formats: () => fetch("/api/data/formats").then((r) => handle<FormatsInfo>(r)),
  recent: () => fetch("/api/data/recent").then((r) => handle<RecentFile[]>(r)),
  meta: (id: string) => fetch(`/api/data/${id}`).then((r) => handle<EditorMeta>(r)),
  /** No path: the OS's own Open dialog (app window only). */
  open: (path?: string) => post<EditorMeta | { cancelled: true }>("/api/data/open", { path }),
  upload: (file: File) =>
    fetch(`/api/data/upload?name=${encodeURIComponent(file.name)}`, { method: "PUT", body: file }).then((r) =>
      handle<EditorMeta>(r),
    ),
  create: (columns: { name: string; kind: Kind }[], format: FormatId) =>
    post<EditorMeta>("/api/data/new", { columns, format }),
  rows: (id: string, offset: number, limit: number) =>
    fetch(`/api/data/${id}/rows?offset=${offset}&limit=${limit}`).then((r) =>
      handle<{ offset: number; rows: Cell[][]; total_rows: number }>(r),
    ),
  edit: <T = Record<string, never>,>(id: string, op: Record<string, unknown>) =>
    post<{ meta: EditorMeta } & T>(`/api/data/${id}/edit`, op),
  duplicates: (id: string, opts: { cols: number[]; ignore_case: boolean; offset?: number }) =>
    post<DuplicateResult>(`/api/data/${id}/clean`, { tool: "duplicates", ...opts }),
  find: (id: string, opts: { text: string; cols: number[]; match: MatchMode; case_sensitive: boolean; offset?: number }) =>
    post<FindResult>(`/api/data/${id}/clean`, { tool: "find", ...opts }),
  save: (id: string, opts: { format: FormatId; pick?: boolean; filename?: string; overwrite?: boolean; path?: string }) =>
    post<EditorMeta | { cancelled: true }>(`/api/data/${id}/save`, opts),
  close: (id: string) => fetch(`/api/data/${id}`, { method: "DELETE" }).catch(() => {}),
  reveal: (path: string) => post("/api/reveal", { path }),
};
