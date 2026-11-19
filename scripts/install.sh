#!/bin/bash
# Installs (or updates) Alotbot from the latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/shashank03-dev/alotbot/main/scripts/install.sh | bash
# Updates an installed copy in place, or puts "Alotbot.app" in /Applications (~/Applications if not writable), and opens it.
set -euo pipefail

url="https://github.com/shashank03-dev/alotbot/releases/latest/download/Alotbot-macOS.zip"
# The release's signing certificate. Anything signed differently is refused.
leaf='certificate leaf = H"220842bdcd29943d1141a6e0c594f3c5ab2d2065"'

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
# Quits an app and waits until it and its backend (the Node inside the app, started from its Contents) have exited.
# Grok Call, the app before the rename, too: its backend would otherwise make a new GrokCall data folder after Alotbot
# moved the old one.
quit_app() {
  local name="$1" inside="/$1.app/Contents/"
  pgrep -f "$inside" >/dev/null || return 0
  echo "Quitting the running $name..."
  osascript -e "quit app \"$name\"" >/dev/null 2>&1 || true
  for _ in {1..40}; do pgrep -f "$inside" >/dev/null || return 0; sleep 0.5; done
  echo "$name is still running. Quit it, then run this again. Nothing was installed." >&2
  exit 1
}
quit_app "Alotbot"
quit_app "Grok Call"
rm -rf "$dest/Alotbot.app"
ditto "$app" "$dest/Alotbot.app"
echo "Installed: $dest/Alotbot.app"
# The copies from before the rename, once the new one is in place.
for old in "/Applications/Grok Call.app" "$HOME/Applications/Grok Call.app"; do
  if [[ -d "$old" ]]; then
    rm -rf "$old"
    echo "Removed the old Grok Call copy: $old"
  fi
done
open "$dest/Alotbot.app"
