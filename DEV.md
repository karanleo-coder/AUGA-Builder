# Developer notes

## Dev workflow (hot reload)

```bash
./start.sh
```

Creates `.venv` (backend deps + the example scripts' own deps) and installs
frontend packages on first run, then starts the FastAPI backend on `:8000`
and the Vite dev server on `:5173` (which proxies `/api/*` and the WebSocket
to the backend). Open `http://localhost:5173`.

Manual two-terminal version:

```bash
# Terminal 1
cd backend && ../.venv/bin/python -m uvicorn main:app --port 8000

# Terminal 2
cd frontend && npm run dev
```

## Architecture

- **`backend/`** — FastAPI. `registry.py` discovers/persists scripts;
  `process_manager.py` runs a script as a plain subprocess (stdin/stdout
  pipes, not a pseudo-terminal — see below) and streams its output live over
  a WebSocket; `main.py` wires up the REST/WebSocket API and, in a packaged
  build, also serves the built frontend as static files with SPA-route
  fallback. `appdirs.py` is the one place that decides *where things live*
  for both dev mode and a packaged build (see next section).
- **`frontend/`** — React + TypeScript + Vite + Tailwind v4. Sidebar script
  picker, a dashboard with circular progress rings per run (SVG, animated),
  a console view that renders prompts as input boxes instead of a raw
  terminal, and a Settings page (rename/recolor/remove/add scripts via a
  built-in file browser).

### Why plain pipes instead of a PTY

An earlier version ran scripts inside a real pseudo-terminal (`pty` module)
for the nicest possible prompt-detection behavior. That module is Unix-only
— it doesn't exist on Windows at all — so cross-platform support meant
switching to plain `subprocess.PIPE` for stdin/stdout on every OS. The
practical difference is small: `input()` doesn't care whether stdin is a
tty or a pipe, and the app already renders prompts and masks secret-looking
ones itself rather than relying on real terminal echo control. The one
visible side effect: `getpass.getpass()` can't silence terminal echo
through a pipe, so it falls back to a plain read and prints a one-line
warning about it — harmless, and the app still masks the value in its own
UI and never stores the real text once submitted for a password/token-style
prompt.

Reading a subprocess's output asynchronously without a PTY still needs to
avoid blocking the event loop; `process_manager.py` does this with one
background thread per run doing blocking reads, handing chunks back to the
asyncio loop via `call_soon_threadsafe` — no C extensions, works identically
on Windows/macOS/Linux.

## How packaging works (`build/build.sh`, `build/build.ps1`)

The packaged app is a **PyInstaller onedir build** of `backend/launcher.py`
(the same FastAPI app as dev mode, started programmatically, with a browser
tab opened once it's up) plus:

1. **The built frontend** (`frontend/dist`), bundled in as PyInstaller
   `datas` at `frontend_dist/`.
2. **Three seed scripts**, bundled in at `seed_scripts/`, copied out to a
   `scripts/` folder next to the executable the first time the app runs.
3. **A portable Python interpreter**, built via `uv python install
   --install-dir ...` (the same underlying project as
   `python-build-standalone` — a real, relocatable CPython build, not a
   venv) with the example scripts' dependencies installed into it. This
   ships as a sibling `python-runtime/` folder next to the executable.
   Scripts are run against *this* interpreter, not whatever Python (if any)
   is on the end user's machine — see `appdirs.bundled_python()`.

**Why onedir, not onefile:** a onefile build re-extracts its entire bundle
to a fresh temp directory on every single launch, which would make every
"Run" click pay that cost again (the launcher re-invokes the bundled Python
interpreter as a normal subprocess per run — not itself, so this isn't about
onefile-vs-onedir startup for that part — but the *app's own* startup would
still be slow, and it just isn't needed since onedir starts instantly and is
just as shareable as a zip).

**Why a bundled portable interpreter instead of PyInstaller-freezing the
scripts themselves:** the console is designed to run *arbitrary* scripts a
person drops in later, with whatever imports they happen to need —
something a fixed set of PyInstaller `hiddenimports` can't anticipate. A
real interpreter with `pip`/`uv pip install` available handles that the same
way it always has in dev mode.

`build/build.sh` / `build/build.ps1` do, per OS: build the frontend → set up
a scratch venv with PyInstaller → build the portable runtime and install
`scripts_requirements.txt` into it → run PyInstaller against
`build/AUGA-Builder.spec` → copy the runtime in as `python-runtime/` →
archive the result (`.tar.gz` on macOS/Linux to preserve executable
permissions, `.zip` on Windows).

`.github/workflows/release.yml` runs both scripts on GitHub-hosted
Windows/macOS/Linux runners in parallel (this is the only way to actually
produce all three — PyInstaller doesn't cross-compile), smoke-tests each
build by launching it and hitting `/api/health`, and on a tag push attaches
all three archives to a GitHub Release.

## Adding a script

Drop a `.py` file into any folder the app scans (the whole project root in
dev mode; the `scripts/` folder next to the executable in a packaged build),
then either click **Rescan for new scripts** in Settings or browse to it
manually to set a custom name/icon/color. If it needs a package the bundled
runtime doesn't already have:

```bash
# dev mode
.venv/bin/pip install <package>

# packaged app
python-runtime/bin/python3 -m pip install <package>      # macOS/Linux
python-runtime\python.exe -m pip install <package>        # Windows
```
