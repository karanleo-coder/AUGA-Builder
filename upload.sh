#!/usr/bin/env bash
# Builds the project, commits it, and pushes it to your GitHub repo — pushing
# a version tag kicks off the GitHub Actions workflow (.github/workflows/
# release.yml) that builds the actual double-click Windows/macOS/Linux
# packages and attaches them to a GitHub Release.
#
# Usage:
#   ./upload.sh                                       # uses 'origin' if set, else asks
#   ./upload.sh git@github.com:you/AUGA-Builder.git    # paste an SSH (or HTTPS) URL -> pushes straight there
#   ./upload.sh --url git@github.com:you/repo.git      # same, as a flag
#   ./upload.sh --repo my-repo-name                    # create a new GitHub repo (via gh) and push to it
#   ./upload.sh --private                              # (with --repo) make the new repo private — default is public
#   ./upload.sh --watch                                # after pushing the tag, watch the Actions run live
#   ./upload.sh --message "..."                        # custom commit message
#
# If you don't pass a URL and there's no 'origin' remote yet, it will ask you
# to paste one (leave blank to create a new repo instead).
#
# Pushing to a URL you provide only needs plain `git` (make sure your SSH key
# is added to GitHub). Creating a new repo needs the GitHub CLI (`gh`),
# logged in (`gh auth login`).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

REPO_NAME="AUGA-Builder"
VISIBILITY="public"
COMMIT_MESSAGE="Update AUGA-Builder"
WATCH=""
REMOTE_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_NAME="$2"; shift 2 ;;
    --url) REMOTE_URL="$2"; shift 2 ;;
    --public) VISIBILITY="public"; shift ;;
    --private) VISIBILITY="private"; shift ;;
    --message) COMMIT_MESSAGE="$2"; shift 2 ;;
    --watch) WATCH="1"; shift ;;
    git@*|ssh://*|https://*.git|https://github.com/*)
      REMOTE_URL="$1"; shift ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
HAVE_GH=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  HAVE_GH="1"
fi

derive_https_url() {
  case "$1" in
    git@github.com:*) echo "https://github.com/${1#git@github.com:}" | sed 's/\.git$//' ;;
    https://*) echo "${1%.git}" ;;
    *) echo "$1" ;;
  esac
}

echo "==> [1/5] Building the project (sanity check before pushing)"
echo "    Building frontend..."
(cd frontend && npm install && npm run build)

echo "    Packaging a local build for this machine's OS (${OSTYPE:-unknown})..."
if [ "$(uname -s)" = "Darwin" ] || [ "$(uname -s)" = "Linux" ]; then
  chmod +x build/build.sh
  ./build/build.sh
else
  echo "    (Skipping local packaging here — Windows packaging happens in CI. Run build\\build.ps1 yourself to test it locally.)"
fi

echo "==> [2/5] Preparing the git repository"
if [ ! -d .git ]; then
  git init
  git branch -m main
fi
git add -A

if ! git diff --cached --quiet; then
  git commit -m "$COMMIT_MESSAGE"
  echo "    Committed changes."
else
  echo "    Nothing new to commit."
fi

CURRENT_BRANCH="$(git branch --show-current)"

echo "==> [3/5] Making sure a GitHub remote is set up"
if git remote get-url origin >/dev/null 2>&1; then
  EXISTING_URL="$(git remote get-url origin)"
  if [ -n "$REMOTE_URL" ] && [ "$REMOTE_URL" != "$EXISTING_URL" ]; then
    echo "    Updating 'origin' from $EXISTING_URL to $REMOTE_URL"
    git remote set-url origin "$REMOTE_URL"
  else
    echo "    Using existing remote: $EXISTING_URL"
  fi
  git push -u origin "$CURRENT_BRANCH"
else
  if [ -z "$REMOTE_URL" ]; then
    echo "    No 'origin' remote yet."
    read -rp "    Paste a repo URL to push to (SSH, e.g. git@github.com:you/repo.git, or HTTPS) — or leave blank to create a new '$REPO_NAME' repo: " REMOTE_URL
  fi
  if [ -n "$REMOTE_URL" ]; then
    echo "    Adding 'origin' -> $REMOTE_URL"
    git remote add origin "$REMOTE_URL"
    git push -u origin "$CURRENT_BRANCH"
  else
    if [ -z "$HAVE_GH" ]; then
      echo "error: no URL given and the GitHub CLI ('gh') isn't available/logged in to create one — install it and run 'gh auth login', or pass a repo URL" >&2
      exit 1
    fi
    echo "    Creating GitHub repo '$REPO_NAME' ($VISIBILITY) and pushing..."
    gh repo create "$REPO_NAME" "--$VISIBILITY" --source=. --remote=origin --push
  fi
fi

echo "==> [4/5] Tagging a release"
LAST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
if [ -z "$LAST_TAG" ]; then
  NEXT_TAG="v1.0.0"
else
  # bump the patch version: vX.Y.Z -> vX.Y.(Z+1)
  NEXT_TAG="$(echo "$LAST_TAG" | awk -F. '{ patch=substr($3,1)+1; print $1"."$2"."patch }')"
fi
echo "    Last tag: ${LAST_TAG:-none} -> New tag: $NEXT_TAG"
git tag -a "$NEXT_TAG" -m "AUGA-Builder $NEXT_TAG"
git push origin "$NEXT_TAG"

echo "==> [5/5] Done"
ORIGIN_URL="$(git remote get-url origin)"
if [ -n "$HAVE_GH" ] && gh repo view >/dev/null 2>&1; then
  REPO_URL="$(gh repo view --json url -q .url)"
else
  REPO_URL="$(derive_https_url "$ORIGIN_URL")"
fi
echo ""
echo "Pushed. GitHub Actions is now building Windows, macOS and Linux packages:"
echo "  $REPO_URL/actions"
echo ""
echo "Once it finishes, the downloadable apps will be attached here:"
echo "  $REPO_URL/releases/tag/$NEXT_TAG"

if [ -n "$WATCH" ]; then
  echo ""
  echo "Watching the build (this can take several minutes)..."
  sleep 5
  if [ -n "$HAVE_GH" ]; then
    gh run watch --exit-status || true
  else
    echo "(--watch needs the GitHub CLI — check the Actions link above instead.)"
  fi
fi
