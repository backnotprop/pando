#!/bin/sh
# Builds and runs the wire v3 harness: Extension/Wire.swift and
# Extension/WireClient.swift (the extension's client) with
# Broker/BrokerCore.swift (the broker) against a fake daemon, in one process.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mac="$here/.."
out=$(mktemp -d)/wire-test
xcrun swiftc -swift-version 6 -O \
  "$mac/Extension/Wire.swift" "$mac/Extension/WireClient.swift" \
  "$mac/Broker/BrokerCore.swift" "$here/main.swift" -o "$out"
"$out"
