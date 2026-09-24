#!/usr/bin/env bash
# Publishes AUGA-Builder: pushes the project source to GitHub, then pushes a
# version tag. The tag starts the "Build & Release" GitHub Actions workflow
# (.github/workflows/release.yml), which builds the Windows, macOS and Linux
# apps on GitHub's machines and publishes them on a GitHub Release.
# Nothing is built on this computer.
#
# Usage:
#   ./upload.sh                                        # push to 'origin' (asks for a repo link if none)
#   ./upload.sh git@github.com:you/AUGA-Builder.git    # push to this repo (SSH or HTTPS link)
#   ./upload.sh --url <repo link>                      # same, as a flag
#   ./upload.sh --repo my-repo-name                    # create a new GitHub repo with this name
#   ./upload.sh --private                              # (new repos only) make it private; default is public
#   ./upload.sh --message "..."                        # custom commit message
#   ./upload.sh --no-wait                              # don't wait for the GitHub build to finish
#
# Login: uses your GitHub CLI login (`gh auth login`), so git never asks for a
# password. If the remote is an SSH link but your SSH key isn't added to
# GitHub, the remote is switched to HTTPS so your gh login is used instead.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

APP_NAME="AUGA-Builder"
REPO_NAME="AUGA-Builder"
VISIBILITY="public"
COMMIT_MESSAGE="Update AUGA-Builder"
REMOTE_URL=""
WAIT="1"
WORKFLOW_FILE="release.yml"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_NAME="$2"; shift 2 ;;
    --url) REMOTE_URL="$2"; shift 2 ;;
    --public) VISIBILITY="public"; shift ;;
    --private) VISIBILITY="private"; shift ;;
    --message) COMMIT_MESSAGE="$2"; shift 2 ;;
    --no-wait) WAIT=""; shift ;;
    --watch) WAIT="1"; shift ;;
    git@*|ssh://*|https://*) REMOTE_URL="$1"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see ./upload.sh --help)" >&2; exit 1 ;;
  esac
done

# ---------- helpers ----------

# Any GitHub link (SSH or HTTPS) -> "owner/repo"
owner_repo() {
  local u="$1"
  u="${u#git@github.com:}"
  u="${u#ssh://git@github.com/}"
  u="${u#https://github.com/}"
  u="${u#http://github.com/}"
  u="${u%/}"
  echo "${u%.git}"
}

is_ssh_url() {
  case "$1" in git@*|ssh://*) return 0 ;; *) return 1 ;; esac
}

ssh_key_works() {
  # GitHub's SSH endpoint exits 1 even on success, so check the message.
  ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
      -T git@github.com 2>&1 | grep -q "successfully authenticated"
}

# Rewrites the README download block so its links point at this repo.
update_readme_links() {
  local repo="$1" block
  [ -f README.md ] || return 0
  grep -q "DOWNLOADS:START" README.md || return 0
  block="$(mktemp)"
  cat > "$block" <<EOF
<!-- DOWNLOADS:START (kept up to date by upload.sh) -->
**[Latest release](https://github.com/$repo/releases/latest)** · direct downloads:

| OS | Download | Run |
|---|---|---|
| Windows (64-bit) | [$APP_NAME-windows-x64.zip](https://github.com/$repo/releases/latest/download/$APP_NAME-windows-x64.zip) | unzip, open the \`$APP_NAME\` folder, double-click \`$APP_NAME.exe\` |
| macOS (Apple Silicon) | [$APP_NAME-macos-arm64.tar.gz](https://github.com/$repo/releases/latest/download/$APP_NAME-macos-arm64.tar.gz) | unzip, open the \`$APP_NAME\` folder, double-click \`$APP_NAME\` (first launch: right-click → Open, since it isn't Apple-notarized) |
| Linux (64-bit) | [$APP_NAME-linux-x64.tar.gz](https://github.com/$repo/releases/latest/download/$APP_NAME-linux-x64.tar.gz) | unzip, \`cd $APP_NAME && ./$APP_NAME\` |
<!-- DOWNLOADS:END -->
EOF
  awk -v blockfile="$block" '
    /DOWNLOADS:START/ { while ((getline line < blockfile) > 0) print line; skip = 1; next }
    /DOWNLOADS:END/   { skip = 0; next }
    !skip { print }
  ' README.md > README.md.tmp && mv README.md.tmp README.md
  rm -f "$block"
}

# ---------- 1. tools & login ----------

echo "==> [1/6] Checking tools and GitHub login"
command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
if ! command -v gh >/dev/null; then
  echo "error: the GitHub CLI ('gh') is required: https://cli.github.com, then run 'gh auth login'" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "error: not logged in to GitHub. Run 'gh auth login' first." >&2
  exit 1
fi
GH_USER="$(gh api user -q .login)"
echo "    Logged in to GitHub as $GH_USER"
# Let git reuse the gh login for github.com over HTTPS: no password prompts.
gh auth setup-git >/dev/null 2>&1 || true

# ---------- 2. repository & remote ----------

echo "==> [2/6] Setting up the repository"
if [ ! -d .git ]; then
  git init -q
  git checkout -q -b main
fi
BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || { BRANCH="main"; git checkout -q -b main; }

if [ -z "$REMOTE_URL" ] && ! git remote get-url origin >/dev/null 2>&1; then
  read -rp "    Paste the GitHub repo link to push to (leave blank to create '$REPO_NAME'): " REMOTE_URL
fi

if [ -n "$REMOTE_URL" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$REMOTE_URL"
  else
    git remote add origin "$REMOTE_URL"
  fi
elif ! git remote get-url origin >/dev/null 2>&1; then
  REMOTE_URL="https://github.com/$GH_USER/$REPO_NAME.git"
  git remote add origin "$REMOTE_URL"
fi

ORIGIN_URL="$(git remote get-url origin)"
REPO="$(owner_repo "$ORIGIN_URL")"

# Create the repo on GitHub if it doesn't exist yet (only under your account).
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  if [ "${REPO%%/*}" = "$GH_USER" ]; then
    echo "    Creating GitHub repo $REPO ($VISIBILITY)"
    gh repo create "$REPO" "--$VISIBILITY" >/dev/null
  else
    echo "error: repo $REPO doesn't exist, or your account ($GH_USER) can't see it" >&2
    exit 1
  fi
fi

# SSH link but no working SSH key -> use HTTPS with the gh login instead.
if is_ssh_url "$ORIGIN_URL" && ! ssh_key_works; then
  echo "    Your SSH key isn't set up with GitHub, so pushing over HTTPS with your gh login instead."
  git remote set-url origin "https://github.com/$REPO.git"
fi
echo "    Pushing to https://github.com/$REPO (branch: $BRANCH)"

# ---------- 3. commit ----------

echo "==> [3/6] Committing project files"
update_readme_links "$REPO"
git add -A
if git diff --cached --quiet; then
  echo "    Nothing new to commit."
else
  git commit -q -m "$COMMIT_MESSAGE"
  echo "    Committed: $COMMIT_MESSAGE"
fi

# ---------- 4. push ----------

echo "==> [4/6] Pushing source to GitHub"
git push -u origin "$BRANCH"

# ---------- 5. tag -> triggers the GitHub build & release ----------

echo "==> [5/6] Tagging a release (this starts the build on GitHub)"
git fetch -q --tags origin || true
LAST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
if [ -z "$LAST_TAG" ]; then
  NEXT_TAG="v1.0.0"
else
  # vX.Y.Z -> vX.Y.(Z+1)
  NEXT_TAG="$(echo "$LAST_TAG" | awk -F. '{ print $1"."$2"."($3+1) }')"
fi
git tag -a "$NEXT_TAG" -m "$APP_NAME $NEXT_TAG"
git push -q origin "$NEXT_TAG"
echo "    Pushed tag $NEXT_TAG (previous: ${LAST_TAG:-none})"

REPO_URL="https://github.com/$REPO"
ACTIONS_URL="$REPO_URL/actions/workflows/$WORKFLOW_FILE"
RELEASE_URL="$REPO_URL/releases/tag/$NEXT_TAG"

# ---------- 6. wait for the GitHub build ----------

if [ -z "$WAIT" ]; then
  echo "==> [6/6] Done. GitHub is building the apps now:"
  echo "    Build progress: $ACTIONS_URL"
  echo "    Release (once built): $RELEASE_URL"
  echo "    Latest downloads: $REPO_URL/releases/latest"
  exit 0
fi

echo "==> [6/6] Waiting for GitHub to build Windows, macOS and Linux apps (usually 5-10 minutes)"
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW_FILE" --limit 20 \
            --json databaseId,headBranch \
            -q ".[] | select(.headBranch == \"$NEXT_TAG\") | .databaseId" 2>/dev/null | head -n1)"
  [ -n "$RUN_ID" ] && break
  sleep 4
done

if [ -z "$RUN_ID" ]; then
  echo "    Couldn't find the build run yet. Check it here: $ACTIONS_URL"
  exit 0
fi

echo "    Build: $REPO_URL/actions/runs/$RUN_ID"
if gh run watch "$RUN_ID" --repo "$REPO" --interval 15 --exit-status; then
  echo ""
  echo "Release $NEXT_TAG is published:"
  echo "  $RELEASE_URL"
  echo "Latest downloads (also linked in the README):"
  echo "  $REPO_URL/releases/latest"
else
  echo ""
  echo "The build failed. Details: $REPO_URL/actions/runs/$RUN_ID" >&2
  exit 1
fi
