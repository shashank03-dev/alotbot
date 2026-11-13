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
  <key>NSScreenCaptureUsageDescription</key><string>Grok Call reads an app window when you ask your bots to look at it.</string>
  <key>NSMicrophoneUsageDescription</key><string>Grok Call sends your voice to the bots in your call.</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>GCRepoPath</key><string>$repo</string>
  <key>GCNodePath</key><string>$node_bin</string>
</dict>
</plist>
PLIST

# Signed with one local certificate so macOS keeps Microphone, Screen Recording and Accessibility
# access across rebuilds (an ad hoc signature changes every build, and macOS then asks again).
# Works on this Mac only. Another Mac needs your Developer ID signature.
sign_name="Grok Call Local Signing"
if ! security find-certificate -c "$sign_name" >/dev/null 2>&1; then
  echo "Creating the local signing certificate \"$sign_name\" in your login keychain (once)."
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$sign_name" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -passout pass:grokcall
  security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P grokcall -T /usr/bin/codesign >/dev/null
fi
codesign --force --deep --sign "$sign_name" "$app"
echo "Built: $app"
