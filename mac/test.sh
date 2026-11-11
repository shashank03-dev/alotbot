#!/bin/bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
swift_bin="$(xcrun --find swiftc)"
# The UI rendering test uses the existing offline demo mode; it must not start a real account backend.
export GROK_CALL_DEMO=1
# CLT's new build driver does not always discover the bundled Swift Testing macro plugin.
plugin="$(dirname "$swift_bin")/../lib/swift/host/plugins/testing/libTestingMacros.dylib"
if [[ -f "$plugin" ]]; then
  swift test --package-path "$here" --enable-code-coverage -Xswiftc -load-plugin-library -Xswiftc "$plugin" "$@"
else
  swift test --package-path "$here" --enable-code-coverage "$@"
fi
