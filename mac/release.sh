#!/bin/bash
# Publishes a release from this Mac, no CI needed: runs every check, builds the download, pushes, and uploads
# it to GitHub as v<package.json version>. Running it again for the same version replaces the download.
#   bash mac/release.sh notes.md
set -euo pipefail
notes="${1:?Usage: bash mac/release.sh <release-notes.md>}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
if [[ -n "$(git status --porcelain)" ]]; then echo "Commit your changes first: the release is built from the last commit." >&2; exit 1; fi
version="$(node -p "require('./package.json').version")"
tag="v$version"

npm test
npm run typecheck
bash mac/test.sh
bash mac/build-app.sh --release

git push origin HEAD
zip="mac/build/Alotbot-macOS.zip"
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "$zip" --clobber
  gh release edit "$tag" --notes-file "$notes"
else
  gh release create "$tag" "$zip" --target "$(git rev-parse HEAD)" --title "Alotbot $version" --notes-file "$notes"
fi
echo "Released $tag: $(gh release view "$tag" --json url --jq .url)"
