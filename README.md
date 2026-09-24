# AUGA-Builder

A local web front end for Python scripts — a sidebar to pick a script, a
live console with clean input boxes instead of raw terminal commands, and a
dashboard with circular progress rings for everything currently running.
Runs multiple scripts at once and picks up new ones automatically.

It ships two ways:

- **A packaged app** — download, unzip, double-click. No Python, Node, or
  install step required on the machine that runs it.
- **A dev setup** — for working on the app itself (see [DEV.md](DEV.md)).

## Download

<!-- DOWNLOADS:START (kept up to date by upload.sh) -->
**[Latest release](https://github.com/karanleo-coder/AUGA-Builder/releases/latest)** · direct downloads:

| OS | Download | Run |
|---|---|---|
| Windows (64-bit) | [AUGA-Builder-windows-x64.zip](https://github.com/karanleo-coder/AUGA-Builder/releases/latest/download/AUGA-Builder-windows-x64.zip) | unzip, open the `AUGA-Builder` folder, double-click `AUGA-Builder.exe` |
| macOS (Apple Silicon) | [AUGA-Builder-macos-arm64.tar.gz](https://github.com/karanleo-coder/AUGA-Builder/releases/latest/download/AUGA-Builder-macos-arm64.tar.gz) | unzip, open the `AUGA-Builder` folder, double-click `AUGA-Builder` (first launch: right-click → Open, since it isn't Apple-notarized) |
| Linux (64-bit) | [AUGA-Builder-linux-x64.tar.gz](https://github.com/karanleo-coder/AUGA-Builder/releases/latest/download/AUGA-Builder-linux-x64.tar.gz) | unzip, `cd AUGA-Builder && ./AUGA-Builder` |
<!-- DOWNLOADS:END -->

These links always point at the newest release. GitHub builds them from
this repo's source on every release — nothing is built on anyone's own
machine.

## Using the app

It opens `http://127.0.0.1:8756` in your default browser automatically —
that tab *is* the app. Closing it doesn't stop the server; quit by closing
the terminal/process the app started (or press Ctrl+C if you launched it
from a terminal).

**Where things live**, right next to the app folder:
- `scripts/` — drop your own `.py` files in here (subfolders OK) and hit
  **Rescan for new scripts** in Settings, or browse to one there directly.
  It comes pre-seeded with three example scripts on first launch.
- `data/` — the app's own state (which scripts are registered, etc.).
- `python-runtime/` — a real, self-contained Python interpreter the app
  uses to run scripts. It's independent of whatever Python (if any) is
  installed on your machine, and already has the example scripts'
  dependencies (`requests`, `pandas`, `beautifulsoup4`, `trafilatura`,
  `pyarrow`) installed. A brand-new script that needs something else can
  have it installed into that same interpreter — see [DEV.md](DEV.md).

Nothing about how a script works needs to change for the console to run it:
scripts using plain `input()` (including password-style prompts) work with
zero configuration.

## For maintainers: publishing a new release

```bash
./upload.sh
```

That's the whole flow. It:

1. Pushes the project's source to GitHub (backend, frontend, build scripts —
   never build outputs).
2. Pushes a new version tag (`v1.0.0`, then `v1.0.1`, …).
3. That tag starts the **Build & Release** workflow on GitHub, which builds
   Windows, macOS and Linux packages on GitHub's own machines, test-launches
   each one, and publishes them on a GitHub Release.
4. Waits for that build to finish and prints the release link.

Nothing is built on your own computer, and the download links above always
point at the newest release.

**Logging in:** it uses your existing GitHub CLI login (`gh auth login`), so
it won't ask for a password. If your remote is an SSH link but your SSH key
isn't added to GitHub, it switches that remote to HTTPS and pushes with your
`gh` login instead.

**Where it pushes:** the existing `origin` remote if there is one. Otherwise
it asks you to paste a repo link, or creates a new repo named
`AUGA-Builder` if you leave it blank. You can also pass the link directly:

```bash
./upload.sh git@github.com:you/AUGA-Builder.git   # push to this repo
./upload.sh --repo my-repo-name                   # create a new repo with this name
./upload.sh --no-wait                             # don't wait for the GitHub build to finish
```

See the comments at the top of `upload.sh` for every option.

To build a local package yourself without publishing anything:

```bash
./build/build.sh          # macOS / Linux -> dist/AUGA-Builder/
./build/build.ps1         # Windows (PowerShell) -> dist\AUGA-Builder\
```

Full architecture notes, the dev (hot-reload) workflow, and how packaging
actually works under the hood are in [DEV.md](DEV.md).
