#!/bin/bash
# Builds "Grok Call.app" into mac/build/. Needs the Xcode command line tools (Swift 6) and Node 22.18+.
#
#   bash mac/build-app.sh            Developer build: runs this repo's backend with your Node, so keep the repo
#                                    where it is, or rebuild after moving it.
#   bash mac/build-app.sh --release  Download build: one app for Apple Silicon and Intel with Node and the backend
#                                    inside, zipped to mac/build/Grok-Call-<version>-macOS.zip. Nothing else to install.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
release=false
case "${1:-}" in
  "") ;;
  --release) release=true ;;
  *) echo "Usage: bash mac/build-app.sh [--release]" >&2; exit 2 ;;
esac

# Node bundled into a release: the version the tests run on, checked against nodejs.org's published checksums.
NODE_VERSION="26.11.1"

node_bin="${GROK_CALL_NODE:-$(command -v node || true)}"
if [[ -z "$node_bin" ]]; then echo "Node.js not found. Install Node 22.18 or newer." >&2; exit 1; fi
node_major="$("$node_bin" -p 'process.versions.node.split(".").map(Number).reduce((a,v,i)=>i<2?a*1000+v:a,0)')"
if (( node_major < 22018 )); then echo "Node $("$node_bin" -v) is too old: Grok Call needs 22.18 or newer." >&2; exit 1; fi
if [[ ! -d "$repo/node_modules/ws" ]]; then (cd "$repo" && npm install --no-audit --no-fund); fi
version="$("$node_bin" -p "require('$repo/package.json').version")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$here"
if $release; then
  swift build -c release --arch arm64 --arch x86_64
  bin="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"
else
  swift build -c release
  bin="$(swift build -c release --show-bin-path)"
fi

app="$here/build/Grok Call.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/GrokCall" "$app/Contents/MacOS/GrokCall"
cp -R "$bin/GrokCall_GrokCallCore.bundle" "$app/Contents/Resources/"
cp "$here/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

# A developer build finds the repo and Node through these keys. A release carries both inside instead.
dev_keys=""
if ! $release; then
  dev_keys="  <key>GCRepoPath</key><string>$repo</string>
  <key>GCNodePath</key><string>$node_bin</string>"
fi

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Grok Call</string>
  <key>CFBundleDisplayName</key><string>Grok Call</string>
  <key>CFBundleIdentifier</key><string>me.shashankdev.grokcall</string>
  <key>CFBundleExecutable</key><string>GrokCall</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Grok Call reads an app window when you ask your bots to look at it or share your screen, and hears a meeting app you choose.</string>
  <key>NSMicrophoneUsageDescription</key><string>Grok Call sends your voice to the bots in your call.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Grok Call transcribes a meeting you choose on this Mac, so your bots can follow it. The audio never leaves this Mac.</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
$dev_keys
</dict>
</plist>
PLIST

if $release; then
  # The backend, with only what it needs to run (no tests, no dev tools).
  backend="$app/Contents/Resources/backend"
  mkdir -p "$backend"
  cp -R "$repo/src" "$repo/public" "$repo/package.json" "$repo/package-lock.json" "$backend/"
  (cd "$backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  rm -f "$backend/package-lock.json"

  # Node for both chips, verified, then joined into one binary.
  base="https://nodejs.org/dist/v$NODE_VERSION"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  for arch in arm64 x64; do
    tarball="node-v$NODE_VERSION-darwin-$arch.tar.gz"
    curl -fsSL "$base/$tarball" -o "$tmp/$tarball"
    want="$(awk -v f="$tarball" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
    got="$(shasum -a 256 "$tmp/$tarball" | awk '{ print $1 }')"
    if [[ -z "$want" || "$want" != "$got" ]]; then echo "Checksum mismatch for $tarball" >&2; exit 1; fi
    tar -xzf "$tmp/$tarball" -C "$tmp" "node-v$NODE_VERSION-darwin-$arch/bin/node"
  done
  lipo -create "$tmp/node-v$NODE_VERSION-darwin-arm64/bin/node" "$tmp/node-v$NODE_VERSION-darwin-x64/bin/node" -output "$app/Contents/MacOS/node"
  chmod 755 "$app/Contents/MacOS/node"
fi

# Signed with one local certificate so macOS keeps Microphone, Screen Recording and Accessibility
# access across rebuilds and updates (an ad hoc signature changes every build, and macOS then asks again).
# It is not an Apple Developer ID, so a downloaded copy still needs one "Open Anyway" (see the README).
sign_name="Grok Call Local Signing"
if ! security find-certificate -c "$sign_name" >/dev/null 2>&1; then
  echo "Creating the local signing certificate \"$sign_name\" in your login keychain (once)."
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$sign_name" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -passout pass:grokcall
  security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P grokcall -T /usr/bin/codesign >/dev/null
fi
if $release; then codesign --force --sign "$sign_name" "$app/Contents/MacOS/node"; fi
codesign --force --sign "$sign_name" "$app"
codesign --verify --strict "$app"
echo "Built: $app"

if $release; then
  zip="$here/build/Grok-Call-macOS.zip" # a fixed name, so releases/latest/download/Grok-Call-macOS.zip always works
  rm -f "$zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
  echo "Zipped: $zip"
  shasum -a 256 "$zip"
fi
