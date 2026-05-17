#!/bin/bash
# End-to-end real-device screenshot via macOS-managed CoreDevice tunnel.
# Reference implementation in shell. Uses pymobiledevice3 for the DTX-layer
# work — porting to native TypeScript is tracked separately.
#
# Usage: screenshot.sh <core-device-identifier> <output.png>
#
#   core-device-identifier: UUID from `xcrun devicectl list devices`
#     (uppercase, e.g. 63307A37-70BC-58CC-AA50-DC9432B15B19)
#
# Requirements on the build machine:
#   - macOS with Xcode (devicectl)
#   - python3
#   - pip3 install pymobiledevice3
#
# Requirements on the device:
#   - paired via Xcode (so CoreDevice knows about it)
#   - Developer Mode enabled
#   - DDI gets mounted automatically by `devicectl device info ddiServices`
#     each time this script runs (a no-op if already mounted)

set -e

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <core-device-identifier> <output.png>" >&2
  exit 2
fi

DEVICE_ID="$1"
OUTPUT="$2"

DEVICE_HOSTNAME="$(echo "$DEVICE_ID" | tr '[:upper:]' '[:lower:]').coredevice.local"

# 1. Spawn devicectl as tunnel keeper. Stays alive for the duration of this
# script; macOS tears the tunnel down within a couple seconds after exit.
xcrun devicectl device info processes --device "$DEVICE_ID" >/dev/null 2>&1 &
KEEPER_PID=$!
# Also kick DDI mount in the background — same usage assertion, idempotent.
xcrun devicectl device install ddi --device "$DEVICE_ID" >/dev/null 2>&1 &

cleanup() {
  kill "$KEEPER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# 2. Wait for the tunnel to come up and mDNS to start resolving.
sleep 3

DEVICE_ADDR="$(dscacheutil -q host -a name "$DEVICE_HOSTNAME" 2>/dev/null \
  | awk '/ipv6_address/{print $2; exit}')"
if [[ -z "$DEVICE_ADDR" ]]; then
  echo "Could not resolve $DEVICE_HOSTNAME — is the tunnel up?" >&2
  exit 1
fi

# 3. Pull the RSD port from system log. The 'for server port' predicate is
# the one log message remotepairingd emits without redacting the port as
# <private>.
RSD_PORT="$(log show --last 30s --info --debug \
  --predicate 'eventMessage CONTAINS "for server port"' --style compact 2>&1 \
  | grep -oE 'server port [0-9]+' | tail -1 | awk '{print $NF}')"
if [[ -z "$RSD_PORT" ]]; then
  echo "Could not find RSD port in system log — is the tunnel up?" >&2
  exit 1
fi

# 4. Invoke pymobiledevice3 with the discovered RSD address + port. pymd3
# handles the full DTX + NSKeyedArchiver dance to talk to
# com.apple.instruments.dtservicehub →
# com.apple.instruments.server.services.screenshot → takeScreenshot.
PMD="$(command -v pymobiledevice3 || echo "$HOME/Library/Python/3.9/bin/pymobiledevice3")"
if [[ ! -x "$PMD" ]]; then
  echo "pymobiledevice3 not found — install with: pip3 install pymobiledevice3" >&2
  exit 1
fi

"$PMD" developer dvt screenshot --rsd "$DEVICE_ADDR" "$RSD_PORT" "$OUTPUT"

if [[ ! -s "$OUTPUT" ]]; then
  echo "Screenshot file is empty — pymd3 failed silently?" >&2
  exit 1
fi
