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

- the device's IPv6 address on the tunnel interface
- the RemoteServiceDiscovery (RSD) port

The canonical source is `log stream`:

```
log stream --info --predicate 'eventMessage LIKE "*Tunnel established*"
                              OR eventMessage LIKE "*for server port*"'
```

A "Tunnel established" message includes the IPv6, and an "RSDPort" message
includes the port. go-ios's `--address` / `--rsd-port` flags consume exactly
this pair.

Fallback if logs don't surface: scrape `ifconfig utun*` for the newest interface
and resolve `<udid>.coredevice.local` via mDNS.

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

## Out of scope (for now)

- Input injection (tap / swipe / type) on real device. Apple's
  `com.apple.dt.testmanagerd` / WebDriverAgent path is much heavier.
- Wired USB devices not paired through CoreDevice. Those are still in
  libimobiledevice territory.
- iOS 16 and earlier. Different transport stack entirely.
