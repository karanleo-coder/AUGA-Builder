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

## How the app window works (`backend/launcher.py`)

The launcher starts the FastAPI server in a background thread and then shows
the UI, trying in order:

1. **Native window** (Windows, macOS): [pywebview](https://pywebview.flowrl.com)
   with the OS's built-in engine: WebView2 on Windows, WKWebView on macOS.
   No browser or terminal involved; closing the window quits the app (if
   scripts are running, the window asks the page to confirm first).
2. **App window** (Linux, or if 1 fails): an installed Chrome / Chromium /
   Edge / Brave in `--app` mode with its own profile under
   `~/AUGA-Builder/data/app-window`, so it's a separate process the launcher
   waits on; when it closes, the app quits. (Linux doesn't get pywebview:
   bundling Qt WebEngine or GTK WebKit would add hundreds of MB and depends
   on distro libraries.)
3. **Browser tab**: last resort; the sidebar then shows a Quit button.

`AUGA_WINDOW=native|app|browser|none` forces a mode (`none` = server only).
Opening the app again while it runs calls `/api/focus` on the running copy
(brings the window back) instead of starting a second one. The UI reads
the current mode from `/api/app-info`.

## How packaging works (`build/build.sh`, `build/build.ps1`)

The packaged app is a **PyInstaller onedir build** of `backend/launcher.py`
(the same FastAPI app as dev mode, started programmatically, with a browser
tab opened once it's up) plus:

1. **The built frontend** (`frontend/dist`), bundled in as PyInstaller
   `datas` at `frontend_dist/`.
2. **Three seed scripts**, bundled in at `seed_scripts/`, copied out to
   `~/AUGA-Builder/scripts` the first time the app runs (on every OS; the
   user's scripts and the app's data never live inside the app, so updating
   is just replacing it).
3. **A portable Python interpreter**, built via `uv python install
   --install-dir ...` (the same underlying project as
   `python-build-standalone` — a real, relocatable CPython build, not a
   venv) with the example scripts' dependencies installed into it. This
   ships as a `python-runtime/` folder next to the executable on
   Windows/Linux, and inside the app (`Contents/Resources/python-runtime`)
   on macOS. Scripts are run against *this* interpreter, not whatever Python
   (if any) is on the end user's machine — see `appdirs.bundled_python()`.

On macOS the build is a real `AUGA-Builder.app` (with `LSUIElement`, since
its window is a browser tab). `build.sh` copies the runtime into it and then
re-seals it with an ad-hoc signature (`codesign --force --deep --sign -`);
without that, macOS reports a downloaded copy as "damaged". (A freshly
downloaded app can run from a read-only temporary location, which is one
more reason `scripts/` and `data/` live in `~/AUGA-Builder`.)

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
produce all three — PyInstaller doesn't cross-compile), runs
`build/smoke_test.py` against each build (starts the app, runs a bundled
example script to its first prompt, checks a second launch reuses the
running app, then quits it), and on a tag push attaches all three archives
to a GitHub Release. You can run the same test locally:
`python3 build/smoke_test.py dist/AUGA-Builder.app/Contents/MacOS/AUGA-Builder`.

**Windows gotcha (fixed in `launcher.py`):** a windowed app on Windows starts
with `sys.stdout`/`sys.stderr` set to `None`, and uvicorn's default logging
crashes on that at startup. The launcher points them at `launcher.log` and
passes `log_config=None` to uvicorn. Script subprocesses are started with
`CREATE_NO_WINDOW` so each run doesn't pop up a console window.

## Publishing a release

Every run of `./upload.sh` publishes a new version:

```bash
./upload.sh --message "Describe what changed"
```

It commits your changes, pushes them, and pushes the next version tag
(`v1.0.1` → `v1.0.2`). That tag makes GitHub build the Windows, macOS and
Linux apps, test-launch each one, and publish them as a new release. The
script waits for the build and prints the release link; the README's
download links always point at the newest release. Nothing is built on your
computer.

```bash
./upload.sh --minor            # v1.0.2 -> v1.1.0  (new features)
./upload.sh --major            # v1.1.0 -> v2.0.0  (big changes)
./upload.sh --version 1.4.0    # exactly v1.4.0
./upload.sh --no-wait          # push and return without waiting for the build
```

It uses your GitHub CLI login (`gh auth login`), so it never asks for a
password; if the remote is an SSH link but your SSH key isn't on GitHub, it
pushes over HTTPS with the `gh` login instead. With no `origin` remote it
asks for a repo link (or creates `AUGA-Builder`). It also keeps the README's
download block (between the `DOWNLOADS:START/END` markers) pointed at the
repo you push to.

To build a package locally without publishing:

```bash
./build/build.sh          # macOS -> dist/AUGA-Builder.app, Linux -> dist/AUGA-Builder/
./build/build.ps1         # Windows (PowerShell) -> dist\AUGA-Builder\
```

## App icon (the silver bar)

`assets/logo.svg` is the master. From it:

| File | Used for |
|---|---|
| `assets/icon.ico` | Windows `.exe` icon (16–256 px) |
| `assets/icon.icns` | macOS `.app` icon (Apple icon grid, with shadow) |
| `assets/icon.png` | Linux app-menu icon, README |
| `frontend/public/logo.svg` | browser tab icon and the sidebar logo (a copy of the master) |

To change the logo, edit `assets/logo.svg`, copy it to
`frontend/public/logo.svg`, and regenerate the raster files with
`assets/render-icons.mjs` (renders every size with headless Chromium via
Playwright), then pack them: `.ico` with Pillow, `.icns` with macOS's
`iconutil`.

## Adding a script

Drop a `.py` file into any folder the app scans (the whole project root in
dev mode; `~/AUGA-Builder/scripts` in the packaged app; Settings → Open
folder takes you there),
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
