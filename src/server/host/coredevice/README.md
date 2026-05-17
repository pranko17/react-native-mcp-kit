# CoreDevice client

A TypeScript reimplementation of just enough of Apple's CoreDevice / RemoteXPC /
DTX stack to take screenshots from a real iOS 17+ device over Wi-Fi without
needing `sudo`, USB cable, or a brew install of libimobiledevice.

## Why this exists

Legacy paths don't work for the current Apple stack:

- `xcrun simctl io <udid> screenshot` — simulator only.
- `xcrun devicectl device screenshot` — does not exist. devicectl ships subcommands
  for `copy / info / install / notification / orientation / process / reboot /
  sysdiagnose / uninstall`, but no screenshot path. devicectl version 518.31
  (Xcode 26).
- `idevicescreenshot` (libimobiledevice) — works only with devices that
  usbmuxd knows about. On macOS 14+/Xcode 26, devices paired through the new
  CoreDevice flow are NOT registered with the legacy usbmuxd, so libimobiledevice
  can't see them. Xcode 26 also removed the "Connect via network" checkbox that
  used to opt a device into Wi-Fi sync.
- AVFoundation (`AVCaptureDevice.devices(for: .muxed)`) — exposes the device
  screen as a muxed video source, but only when the device is USB-connected.
  Over Wi-Fi the device appears only as a Continuity Camera (camera feed, not
  screen).
- Xcode private frameworks (`DVTDeviceScreenshotClient` in `DVTFoundation.framework`)
  — usable in theory but iOS device locators refuse to register outside Xcode's
  bundle context (`DVTPlugInHostRequirements` gates loading). Bundle-spoofing
  would be needed.
- `go-ios screenshot` — works, but needs `sudo ios tunnel start` running
  persistently for iOS 17+ devices. We don't want to ship anything that prompts
  for sudo.

What does work: when `xcrun devicectl` runs an operation against a real device,
macOS's existing CoreDevice infrastructure brings up the tunnel for the duration
of that operation. We piggy-back on that — keep a devicectl operation alive as
a tunnel keeper, then speak the protocol stack ourselves to take a screenshot.

## Stack overview

```
  +----------------------------------------+
  |  DTScreenshotService (this file's job) |   Layer 6
  +----------------------------------------+
  |  DTServiceHub + DTX protocol           |   Layer 5
  +----------------------------------------+
  |  RemoteXPC framing                     |   Layer 4
  +----------------------------------------+
  |  RemoteServiceDiscoveryProxy (RSD)     |   Layer 3
  +----------------------------------------+
  |  Tunnel address discovery              |   Layer 2
  +----------------------------------------+
  |  Tunnel keeper (devicectl background)  |   Layer 1
  +----------------------------------------+
  |  CoreDevice tunnel (provided by macOS) |
  +----------------------------------------+
```

Each layer is implemented as a focused TS module under this directory.

### Layer 1: Tunnel keeper (`tunnel.ts`)

Spawns `xcrun devicectl device info ddiServices --device <id>` (or equivalent)
in the background. While that process runs:

- `tunnelState` flips to `connected`
- `ddiServicesAvailable` flips to `true`
- A new `utun<N>` interface appears on the Mac
- `com.apple.dt.DTScreenshotService` and friends become reachable through the
  tunnel

When the keeper process exits, macOS tears the tunnel down within seconds.
The keeper restarts the underlying devicectl op as needed so the tunnel stays
up for the lifetime of the keeper handle.

A long-term alternative is a small Swift CLI that calls
`CoreDevice.CapabilityStaticMember.acquireUsageAssertion` directly (we saw this
symbol in `CoreDevice.framework`) — cleaner than shelling out to devicectl, but
defers to a follow-up to avoid introducing more native code in the first cut.

### Layer 2: Address discovery (`tunnel.ts`, same module)

Once the keeper reports tunnel up, we need:

- the device's IPv6 address on the tunnel interface — **done**, via mDNS
  resolution of `<udid-lowercased>.coredevice.local`.
- the RemoteServiceDiscovery (RSD) port — **open**, see PROTOCOL.md for the
  detailed write-up of dead ends and remaining options. tl;dr: pure piggy-back
  isn't enough because the RSD port comes from an encrypted handshake on a
  control channel the OS-managed tunnel doesn't re-export.

### Layer 3: RSD client (`rsd.ts`) — NOT YET IMPLEMENTED

RemoteServiceDiscoveryProxy speaks an Apple-flavored HTTP/2-like protocol over
TCP/IPv6. Reference: `pymobiledevice3/remote/remote_service_discovery.py` and
`pymobiledevice3/remote/remotexpc.py`.

Once connected, we exchange a Handshake plist and receive back a dict mapping
service names → ports. The service we care about is
`com.apple.instruments.dtservicehub` (the modern entry point that fronts
DTScreenshotService and other DT services).

### Layer 4: RemoteXPC framing (`remotexpc.ts`) — NOT YET IMPLEMENTED

Apple's binary serialization of `xpc_dictionary_t`. Reference:
`pymobiledevice3/remote/xpc_message.py`. Magic header, type tags, dict and
array encoding.

### Layer 5: DTServiceHub + DTX (`dtx.ts`) — NOT YET IMPLEMENTED

DTX is the binary RPC protocol that Xcode's instruments stack speaks over a
service-hub connection. Frame header: total bytes, conversation_index,
channel_code, expects_reply, message_type, length. Payload is an NSKeyedArchiver
plist holding selector + arguments. Reference: `pymobiledevice3/services/remote/`.

### Layer 6: DTScreenshotService (`screenshot.ts`) — NOT YET IMPLEMENTED

Open a channel for `com.apple.instruments.server.services.screenshot` via the
service hub, invoke `takeScreenshot`, receive PNG bytes in the reply.

## Activating the tunnel by hand (for testing)

```bash
DEV=63307A37-70BC-58CC-AA50-DC9432B15B19   # CoreDevice UUID from devicectl
xcrun devicectl device info ddiServices --device "$DEV"   # tunnel + DDI mount
```

State after: `tunnelState: connected`, `ddiServicesAvailable: True`,
a new `utun<N>` interface up with MTU 16000 (the iPhone tunnel).

State degrades to `disconnected` within seconds after the command exits.

## Current status (2026-05-17)

**End-to-end real-device screenshot is working.** Run
`./screenshot.sh <core-device-uuid> /tmp/shot.png` and you get a 1320×2868
PNG off the iPhone over Wi-Fi, no sudo, no USB cable. The shim composes:

- our Layer 1 + 2A + 2B work (tunnel keeper, mDNS resolution, log-parsed
  RSD port)
- `pymobiledevice3 developer dvt screenshot --rsd <addr> <port>` for the
  DTX-layer work (Layers 4–6 below)

That confirms the approach works against iOS 26.5 today and gives us a
reference implementation we can port to native TypeScript.

Per-layer status:

- **Layer 1** (tunnel keeper): working in TS (`tunnel.ts`).
- **Layer 2A** (device address): working in TS (`tunnel.ts`).
- **Layer 2B** (RSD port): working in `probe.py` and `screenshot.sh`,
  not yet in TS. Parsed from `log show --predicate 'eventMessage CONTAINS
  "for server port"'` — the only predicate that doesn't get redacted as
  `<private>`. Port is dynamic per tunnel session.
- **Layer 3** (RSD client + RemoteXPC): working in `probe.py`. Two
  non-obvious requirements:
  1. Bind the source socket to the Mac end of the tunnel
     (`fd<prefix>::2` from `ifconfig utun<N>`). Default routing picks the
     wrong utun on hosts with multiple tunnels (Tailscale, WireGuard, …).
  2. No TLS. Inside the macOS-managed tunnel, RSD speaks plain HTTP/2.
     The pair-record / PSK-TLS infrastructure that pymobiledevice3 needs
     for its OWN sudo-tunnel is not required here.
- **Layers 4–6** (DTX framing, DTServiceHub channel handshake,
  DTScreenshotService): currently offloaded to pymobiledevice3 in
  `screenshot.sh`. Porting to native TS is the next milestone — see
  PROTOCOL.md for the wire-format reference.

## Service discovery output (iOS 26.5, observed)

The Services dict returned by RSD does NOT include
`com.apple.mobile.screenshotr`. Apple removed it from RSD on the modern
stack. Candidates for taking a screenshot through the discovered services:

- `com.apple.instruments.dtservicehub` — DTServiceHub. Hosts a screenshot
  channel internally (`com.apple.instruments.server.services.screenshot`).
  Requires DTX protocol + a minimal NSKeyedArchiver
  encoder/decoder for the payload.
- `com.apple.mobile.lockdown.remote.trusted` — modern trusted-lockdownd shim.
  If it speaks the legacy lockdownd plist protocol, `StartService(name:
  "com.apple.mobile.screenshotr")` might still return a port for the
  legacy DDI screenshotr (which is dormant but startable). Smaller protocol
  surface; worth probing before committing to DTX.
- `com.apple.dt.testmanagerd.remote` / `.remote.automation` — XCTest harness.
  Heavy. WebDriverAgent-style. Out of scope for "just take a screenshot".

The lockdownd path is the next thing to try in a follow-up session.

## Realistic scope of completing the stack

Once Layer 2B is resolved, the rest of the stack still requires:

- **RemoteXPC framing** (custom HTTP/2 + Apple's binary XPC dict format) —
  500-800 LoC TS.
- **DTServiceHub + DTX protocol** (NSKeyedArchiver-compat plists, channel
  multiplexing, multi-fragment messages) — 1000-1500 LoC TS, including a
  minimal NSKeyedArchiver encoder/decoder.
- **DTScreenshotService client** + integration — 100-200 LoC TS.

If Layer 2B requires reimplementing the full pairing handshake (TCP+TLS-PSK
control channel against `_remotepairing._tcp` on Wi-Fi, plus X25519 ECDH,
Ed25519 signatures, SRP-6a re-pair, AES-GCM, pair record extraction), add
another 2000-3000 LoC and a full crypto stack.

If Layer 2B can be resolved by XPC-talking to
`com.apple.CoreDevice.CoreDeviceService` (the daemon that already holds the
answer), the rest of the stack still applies, but we save the pairing client.
The XPC interface is private Swift and undocumented — would need a Swift
helper binary similar to `ios-hid`. Smaller (~500-1000 LoC Swift) but still
significant.

The honest estimate for a working end-to-end real-device screenshot via this
stack is **2-4 weeks of focused work**, not the 1-2 weeks projected initially.

## Out of scope (for now)

- Input injection (tap / swipe / type) on real device. Apple's
  `com.apple.dt.testmanagerd` / WebDriverAgent path is much heavier.
- Wired USB devices not paired through CoreDevice. Those are still in
  libimobiledevice territory.
- iOS 16 and earlier. Different transport stack entirely.
