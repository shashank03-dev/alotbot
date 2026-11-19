#!/bin/bash
# Installs (or updates) Alotbot from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/shashank03-dev/grok-call/main/scripts/install.sh | bash
# Updates an installed copy in place, or puts "Alotbot.app" in /Applications (~/Applications if not writable), and opens it.
set -euo pipefail

url="https://github.com/shashank03-dev/grok-call/releases/latest/download/Alotbot-macOS.zip"
# The release's signing certificate. Anything signed differently is refused.
leaf='certificate leaf = H"76ad9344822a11b58842358d88ef427ff9740c99"'

if [[ "$(uname -s)" != "Darwin" ]]; then echo "Alotbot runs on macOS only." >&2; exit 1; fi
major="$(sw_vers -productVersion | cut -d. -f1)"
if (( major < 14 )); then echo "Alotbot needs macOS 14 or newer (this Mac has $(sw_vers -productVersion))." >&2; exit 1; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Alotbot..."
curl -fL --progress-bar "$url" -o "$tmp/Alotbot-macOS.zip"
ditto -x -k "$tmp/Alotbot-macOS.zip" "$tmp"
app="$tmp/Alotbot.app"
codesign --verify --strict "$app"
if ! codesign -d -r- "$app" 2>&1 | grep -qF "$leaf"; then echo "The download is not signed by Alotbot's release certificate. Not installed." >&2; exit 1; fi

# Update a copy that is already installed; otherwise /Applications, or ~/Applications if that isn't writable.
dest=""
for d in "/Applications" "$HOME/Applications"; do [[ -d "$d/Alotbot.app" ]] && { dest="$d"; break; }; done
if [[ -z "$dest" ]]; then dest="/Applications"; [[ -w "$dest" ]] || dest="$HOME/Applications"; fi
mkdir -p "$dest"
if pgrep -xq Alotbot; then
  echo "Quitting the running Alotbot..."
  osascript -e 'quit app "Alotbot"' >/dev/null 2>&1 || true
  for _ in {1..20}; do pgrep -xq Alotbot || break; sleep 0.5; done
fi
rm -rf "$dest/Alotbot.app"
ditto "$app" "$dest/Alotbot.app"
echo "Installed: $dest/Alotbot.app"
# The copy from before the rename, once the new one is in place.
if [[ -d "/Applications/Grok Call.app" ]]; then
  rm -rf "/Applications/Grok Call.app"
  echo "Removed the old Grok Call copy: /Applications/Grok Call.app"
fi
open "$dest/Alotbot.app"
