#!/bin/bash
# Installs (or updates) Grok Call from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/shashank03-dev/grok-call/main/scripts/install.sh | bash
# Puts "Grok Call.app" in /Applications (or ~/Applications if that isn't writable) and opens it.
set -euo pipefail

url="https://github.com/shashank03-dev/grok-call/releases/latest/download/Grok-Call-macOS.zip"
# The release's signing certificate. Anything signed differently is refused.
leaf='certificate leaf = H"76ad9344822a11b58842358d88ef427ff9740c99"'

if [[ "$(uname -s)" != "Darwin" ]]; then echo "Grok Call runs on macOS only." >&2; exit 1; fi
major="$(sw_vers -productVersion | cut -d. -f1)"
if (( major < 14 )); then echo "Grok Call needs macOS 14 or newer (this Mac has $(sw_vers -productVersion))." >&2; exit 1; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Grok Call..."
curl -fL --progress-bar "$url" -o "$tmp/Grok-Call-macOS.zip"
ditto -x -k "$tmp/Grok-Call-macOS.zip" "$tmp"
app="$tmp/Grok Call.app"
codesign --verify --strict "$app"
if ! codesign -d -r- "$app" 2>&1 | grep -qF "$leaf"; then echo "The download is not signed by Grok Call's release certificate. Not installed." >&2; exit 1; fi

dest="/Applications"
[[ -w "$dest" ]] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
if pgrep -xq GrokCall; then
  echo "Quitting the running Grok Call..."
  osascript -e 'quit app "Grok Call"' >/dev/null 2>&1 || true
  for _ in {1..20}; do pgrep -xq GrokCall || break; sleep 0.5; done
fi
rm -rf "$dest/Grok Call.app"
ditto "$app" "$dest/Grok Call.app"
echo "Installed: $dest/Grok Call.app"
open "$dest/Grok Call.app"
