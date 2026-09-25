import type { RunSummary, ScriptInfo } from "./types";

/** Adding scripts from a folder, a .zip or a .py file (see backend/importer.py). */

export interface ImportResult {
  folder: string;
  scripts: ScriptInfo[];
  requirements_run: RunSummary | null;
}

export class ImportConflict extends Error {
  folderName: string;
  path?: string;

  constructor(message: string, folderName: string, path?: string) {
    super(message);
    this.folderName = folderName;
    this.path = path;
  }
}

export interface UploadFile {
  file: File;
  path: string; // relative path, e.g. "my_tool/utils/helpers.py"
}

// Never worth uploading (and often huge).
const JUNK_PARTS = new Set([
  "node_modules", ".git", ".hg", ".svn", "venv", ".venv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".idea", ".vscode", "__MACOSX",
]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const MAX_FILES = 5000;

export function keepFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return !JUNK_FILES.has(name) && !parts.slice(0, -1).some((p) => JUNK_PARTS.has(p));
}

async function handle(res: Response): Promise<ImportResult | { cancelled: true }> {
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 409) {
    throw new ImportConflict(String(body.detail), String(body.conflict), body.path as string | undefined);
  }
  if (!res.ok) throw new Error(String(body.detail ?? res.statusText));
  return body as unknown as ImportResult | { cancelled: true };
}

const postJson = (url: string, data: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

/** App window: the OS's own folder/file picker. */
export const pickAndImport = (kind: "folder" | "file") => postJson("/api/import/pick", { kind }).then(handle);

/** Retry a picked path, replacing the existing folder. */
export const importPath = (path: string, replace: boolean) =>
  postJson("/api/import/path", { path, replace }).then(handle) as Promise<ImportResult>;

/** Browser mode / drag-and-drop: upload the files, then finish. */
export async function uploadFiles(files: UploadFile[], onProgress: (done: number, total: number) => void) {
  const kept = files.filter((f) => keepFile(f.path));
  if (kept.length === 0) throw new Error("Nothing to add: no files found.");
  if (kept.length > MAX_FILES) throw new Error(`That's too many files (over ${MAX_FILES}).`);

  const { id } = (await postJson("/api/import/uploads", {}).then((r) => r.json())) as { id: string };
  let done = 0;
  onProgress(0, kept.length);
  const queue = [...kept];
  // A few uploads at a time: fast, without flooding the local server.
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const res = await fetch(`/api/import/uploads/${id}?path=${encodeURIComponent(item.path)}`, {
        method: "PUT",
        body: item.file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Upload failed (${res.status})`);
      }
      onProgress(++done, kept.length);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    discardUpload(id);
    throw e;
  }
  return id;
}

export const finishUpload = (id: string, replace: boolean) =>
  postJson(`/api/import/uploads/${id}/finish`, { replace }).then(handle) as Promise<ImportResult>;

export const discardUpload = (id: string) => {
  fetch(`/api/import/uploads/${id}`, { method: "DELETE" }).catch(() => {});
};

// ---- drag and drop: walk dropped folders -----------------------------------

type Entry = FileSystemEntry;

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const all: Entry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next(); // readEntries returns results in chunks
        }
      }, reject);
    next();
  });
}

async function walk(entry: Entry, out: UploadFile[]): Promise<void> {
  const path = entry.fullPath.replace(/^\//, "");
  if (!keepFile(entry.isDirectory ? path + "/x" : path)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, path });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) {
      await walk(child, out);
      if (out.length > MAX_FILES) return;
    }
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<UploadFile[]> {
  const entries = [...dt.items]
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry() : null))
    .filter((e): e is Entry => !!e);
  const out: UploadFile[] = [];
  if (entries.length) {
    for (const e of entries) await walk(e, out);
  } else {
    for (const file of [...dt.files]) out.push({ file, path: file.name });
  }
  return out;
}
