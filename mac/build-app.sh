#!/bin/bash
# Builds "Grok Call.app" into mac/build/. Needs the Xcode command line tools (Swift 6) and Node 22.18+.
# The app runs this repo's backend (src/overlay/main.ts), so keep the repo where it is, or rebuild after moving it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
node_bin="${GROK_CALL_NODE:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then echo "Node.js not found. Install Node 22.18 or newer." >&2; exit 1; fi
node_major="$("$node_bin" -p 'process.versions.node.split(".").map(Number).reduce((a,v,i)=>i<2?a*1000+v:a,0)')"
if (( node_major < 22018 )); then echo "Node $("$node_bin" -v) is too old: Grok Call needs 22.18 or newer." >&2; exit 1; fi
if [[ ! -d "$repo/node_modules/ws" ]]; then (cd "$repo" && npm install --no-audit --no-fund); fi

cd "$here"
swift build -c release
bin="$(swift build -c release --show-bin-path)"

app="$here/build/Grok Call.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/GrokCall" "$app/Contents/MacOS/GrokCall"
cp -R "$bin/GrokCall_GrokCallCore.bundle" "$app/Contents/Resources/"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Grok Call</string>
  <key>CFBundleDisplayName</key><string>Grok Call</string>
  <key>CFBundleIdentifier</key><string>me.shashankdev.grokcall</string>
  <key>CFBundleExecutable</key><string>GrokCall</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Grok Call sends your voice to the bots in your call.</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>GCRepoPath</key><string>$repo</string>
  <key>GCNodePath</key><string>$node_bin</string>
</dict>
</plist>
PLIST

# Signed for this Mac only (ad hoc). Another Mac needs your Developer ID signature.
codesign --force --deep --sign - "$app"
echo "Built: $app"
