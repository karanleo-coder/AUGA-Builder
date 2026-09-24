# AUGA-Builder

A local web front end for Python scripts — a sidebar to pick a script, a
live console with clean input boxes instead of raw terminal commands, and a
dashboard with circular progress rings for everything currently running.
Runs multiple scripts at once and picks up new ones automatically.

It ships two ways:

- **A packaged app** — download, unzip, double-click. No Python, Node, or
  install step required on the machine that runs it.
- **A dev setup** — for working on the app itself (see [DEV.md](DEV.md)).

## Get the packaged app

Grab the archive for your OS from the project's **GitHub Releases** page,
unzip it, and run the app inside:

| OS | File | Run |
|---|---|---|
| Windows | `AUGA-Builder-windows-*.zip` | unzip, open the `AUGA-Builder` folder, double-click `AUGA-Builder.exe` |
| macOS | `AUGA-Builder-macos-*.tar.gz` | unzip, open the `AUGA-Builder` folder, double-click `AUGA-Builder` (first launch: right-click → Open, since it isn't Apple-notarized) |
| Linux | `AUGA-Builder-linux-*.tar.gz` | unzip, `cd AUGA-Builder && ./AUGA-Builder` |

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

## For maintainers: building & publishing new packages

```bash
./upload.sh
```

This builds the frontend, packages a local build for your own OS as a sanity
check, commits everything, and pushes to GitHub — then pushes a version tag,
which triggers `.github/workflows/release.yml`. That workflow builds
Windows, macOS and Linux packages in parallel on GitHub's own runners (this
is what actually produces all three platforms — you can only build for the
OS you're on locally) and publishes them as assets on a GitHub Release.

For **where** it pushes: if you already have a git remote configured, it
just uses that. Otherwise it asks — paste a repo URL (SSH, e.g.
`git@github.com:you/AUGA-Builder.git`, or HTTPS) and it pushes there
directly, or leave it blank and it creates a new GitHub repo for you via
`gh` (default name `AUGA-Builder`, private). You can also skip the prompt:

```bash
./upload.sh git@github.com:you/AUGA-Builder.git   # push straight to this remote
./upload.sh --repo my-repo-name                   # create a new repo with this name
```

Requires the [GitHub CLI](https://cli.github.com) (`gh`), logged in
(`gh auth login`) — only needed when letting it create the repo for you;
pushing to a URL you paste yourself just uses plain `git` (over SSH, so
make sure your SSH key is added to GitHub). See the usage comments at the
top of `upload.sh` for every option (`--repo`, `--public`, `--watch`,
`--message`).

To build a local package yourself without publishing anything:

```bash
./build/build.sh          # macOS / Linux -> dist/AUGA-Builder/
./build/build.ps1         # Windows (PowerShell) -> dist\AUGA-Builder\
```

Full architecture notes, the dev (hot-reload) workflow, and how packaging
actually works under the hood are in [DEV.md](DEV.md).
