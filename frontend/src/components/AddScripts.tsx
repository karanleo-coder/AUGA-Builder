import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, Package, Play, Upload } from "../icons";
import {
  discardUpload,
  filesFromDrop,
  finishUpload,
  ImportConflict,
  importPath,
  pickAndImport,
  uploadFiles,
  type ImportResult,
  type UploadFile,
} from "../importClient";
import { useStore } from "../store";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; message: string }
  | { kind: "done"; result: ImportResult }
  | { kind: "error"; message: string };

/** Add scripts by dropping or choosing a folder, a .zip or a .py file. */
export function AddScripts() {
  const nativeDialogs = useStore((s) => s.nativeDialogs);
  const loadScripts = useStore((s) => s.loadScripts);
  const trackRun = useStore((s) => s.trackRun);
  const startRun = useStore((s) => s.startRun);
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = status.kind === "busy";

  async function succeeded(result: ImportResult) {
    await loadScripts();
    if (result.requirements_run) trackRun(result.requirements_run);
    setStatus({ kind: "done", result });
  }

  function askReplace(name: string) {
    return confirm(`"${name}" is already in your scripts.\n\nReplace it with the one you just added?`);
  }

  function failed(e: unknown) {
    setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }

  // App window: the OS's own Finder / Explorer picker, imported straight from disk.
  async function pick(kind: "folder" | "file") {
    setStatus({ kind: "busy", message: "Choose what to add…" });
    try {
      const res = await pickAndImport(kind);
      if ("cancelled" in res) return setStatus({ kind: "idle" });
      await succeeded(res);
    } catch (e) {
      if (e instanceof ImportConflict && e.path) {
        if (!askReplace(e.folderName)) return setStatus({ kind: "idle" });
        setStatus({ kind: "busy", message: "Replacing…" });
        try {
          await succeeded(await importPath(e.path, true));
        } catch (e2) {
          failed(e2);
        }
      } else failed(e);
    }
  }

  // Browser mode and drag-and-drop: upload the files.
  async function upload(files: UploadFile[]) {
    if (!files.length) return;
    let id: string | null = null;
    try {
      id = await uploadFiles(files, (done, total) =>
        setStatus({ kind: "busy", message: `Copying ${done} of ${total} files…` }),
      );
      setStatus({ kind: "busy", message: "Adding…" });
      await succeeded(await finishUpload(id, false));
    } catch (e) {
      if (e instanceof ImportConflict && id) {
        if (!askReplace(e.folderName)) {
          discardUpload(id);
          return setStatus({ kind: "idle" });
        }
        try {
          await succeeded(await finishUpload(id, true));
        } catch (e2) {
          failed(e2);
        }
      } else failed(e);
    }
  }

  function choose(kind: "folder" | "file") {
    if (nativeDialogs) pick(kind);
    else (kind === "folder" ? folderInput : fileInput).current?.click();
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = [...(e.target.files ?? [])].map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
    e.target.value = ""; // allow choosing the same thing again
    upload(list);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    setStatus({ kind: "busy", message: "Reading…" });
    try {
      await upload(await filesFromDrop(e.dataTransfer));
    } catch (err) {
      failed(err);
    }
  }

  return (
    <div
      className="mb-6 rounded-2xl border p-4"
      style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
    >
      <p className="text-sm font-semibold">Add scripts</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="mt-3 flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors"
        style={{
          borderColor: dragging ? "var(--accent)" : "var(--border)",
          background: dragging ? "var(--bg-inset)" : "transparent",
        }}
      >
        <Upload size={26} style={{ color: "var(--accent)" }} />
        <div>
          <p className="text-sm font-medium">Drop a folder, a .zip or a .py file here</p>
          <p className="mx-auto mt-1 max-w-md text-xs" style={{ color: "var(--text-faint)" }}>
            It's copied into your scripts folder, the scripts you can run are found for you, and a
            requirements.txt is installed automatically.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            disabled={busy}
            onClick={() => choose("folder")}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-text)" }}
          >
            <Folder size={14} />
            Choose folder…
          </button>
          <button
            disabled={busy}
            onClick={() => choose("file")}
            className="rounded-lg border px-3.5 py-2 text-sm font-medium hover:bg-[var(--bg-inset)] disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
          >
            Choose .zip or .py…
          </button>
        </div>
        <input
          ref={folderInput}
          type="file"
          className="hidden"
          onChange={onInputChange}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
        <input ref={fileInput} type="file" accept=".zip,.py" className="hidden" onChange={onInputChange} />
      </div>

      {status.kind === "busy" && (
        <p className="mt-3 text-xs animate-pulse-soft" style={{ color: "var(--text-muted)" }}>
          {status.message}
        </p>
      )}
      {status.kind === "error" && (
        <p className="mt-3 text-xs" style={{ color: "#fb7185" }}>
          {status.message}
        </p>
      )}
      {status.kind === "done" && (
        <div className="mt-3 animate-fade-in rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
          <p className="text-sm font-medium">
            Added {status.result.scripts.length} script{status.result.scripts.length === 1 ? "" : "s"}
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {status.result.scripts.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">{s.name}</span>
                <button
                  onClick={async () => navigate(`/runs/${(await startRun(s.id)).id}`)}
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold"
                  style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                >
                  <Play size={11} />
                  Run
                </button>
              </div>
            ))}
          </div>
          {status.result.requirements_run && (
            <button
              onClick={() => navigate(`/runs/${status.result.requirements_run!.id}`)}
              className="mt-3 flex items-center gap-1.5 text-xs font-medium hover:underline"
              style={{ color: "var(--accent)" }}
            >
              <Package size={12} />
              Installing its requirements.txt: see progress
            </button>
          )}
        </div>
      )}
    </div>
  );
}
