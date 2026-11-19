#!/bin/bash
# Refuses a release tag already made on another commit (here or on origin): that is an earlier release, and uploading
# to it would replace its download. The same commit is fine: running a release again for it replaces the download.
#   bash mac/release-tag-check.sh v1.1.0
set -euo pipefail
tag="${1:?Usage: bash mac/release-tag-check.sh <tag>}"
head="$(git rev-parse HEAD)"
tagged="$(git rev-parse -q --verify "refs/tags/$tag^{commit}" || true)"
# Not fetched here: ask origin (an annotated tag's commit is the "^{}" line, listed last).
if [[ -z "$tagged" ]]; then tagged="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" 2>/dev/null | awk '{print $1}' | tail -1 || true)"; fi
if [[ -n "$tagged" && "$tagged" != "$head" ]]; then
  echo "$tag is already tagged on ${tagged:0:7}, not on this commit (${head:0:7}). Bump the version in package.json first." >&2
  exit 1
fi
