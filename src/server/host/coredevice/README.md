# CoreDevice client

TypeScript client that talks to a real iOS 17+ device over Apple's
CoreDevice tunnel and returns a PNG screenshot. Used by `host__screenshot`
when the connected RN client reports `isSimulator: false` on the handshake.

No `sudo`, no USB cable, no native binaries beyond what comes with Xcode.

## Stack

```
  ┌────────────────────────────────────────────────────────┐
  │ captureScreenshot(coreDeviceIdentifier)   screenshot.ts │
  └────────────────────────────────────────────────────────┘
       │
       │  bring up tunnel, enumerate services, speak DTX
       ▼
  ┌─────────────────────┐  ┌──────────────────┐  ┌──────────┐
  │ DTServiceHub channel │  │ NSKeyedArchiver  │  │ DTX wire │
  │   `_request…` +      │  │ encode/decode    │  │ framing  │
  │   `takeScreenshot`   │  │   nska.ts        │  │   dtx.ts │
  │      screenshot.ts   │  │                  │  │          │
  └─────────────────────┘  └──────────────────┘  └──────────┘
       ▲                                              ▲
       │                                              │
  ┌─────────────────────────────────────────────────────┐
  │ RSD peer_info enumerate (HTTP/2 + RemoteXPC)        │
  │   rsd.ts ────────► xpc.ts (XpcWrapper + XpcObject)  │
  └─────────────────────────────────────────────────────┘
       ▲
       │
  ┌──────────────────────────────────────────────────────┐
  │ Tunnel keeper + mDNS device address +                 │
  │ system-log RSD port + utun source-bind                │
  │   tunnel.ts                                           │
  └──────────────────────────────────────────────────────┘
       ▲
       │
  ┌──────────────────────────────────────────────────────┐
  │ macOS-managed CoreDevice tunnel                       │
  │ (held up by a backgrounded `devicectl` op)            │
  └──────────────────────────────────────────────────────┘
```

## Modules

| File            | What it does                                                                                                                                                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tunnel.ts`     | Spawns `xcrun devicectl device info processes` in a loop as the tunnel keeper. Resolves the device's tunnel IPv6 via mDNS (`<udid>.coredevice.local`). Finds the matching `utun<N>` interface for the source bind. Parses the RSD port out of `log show` (the `eventMessage CONTAINS "for server port"` predicate is the only one the OS doesn't redact). |
| `xpc.ts`        | Encode/decode for the binary XpcObject format and its `XpcWrapper` framing.                                                                                                                                                                                                                                                                               |
| `rsd.ts`        | HTTP/2-framed client for `RemoteServiceDiscoveryProxy`. Connects to the tunnel's RSD port, runs the handshake on streams 1 and 3, returns the device's peer-info dict with all available services and their tunnel-side ports.                                                                                                                            |
| `nska.ts`       | Minimal `NSKeyedArchiver` codec over `bplist-creator` / `bplist-parser`. Enough to encode method names, argument arrays, and decode `NSData` / `NSDictionary` / `NSError` replies.                                                                                                                                                                        |
| `dtx.ts`        | DTX wire framing (32-byte fragment header, multi-fragment reassembly), DTX aux primitives, and a `DtxConnection` class that owns a TCP socket and matches replies by identifier.                                                                                                                                                                          |
| `screenshot.ts` | Composes the layers above: brings up the tunnel, enumerates services, opens DTX to `dtservicehub`, does the capability handshake, binds a channel to the screenshot service, calls `takeScreenshot`, returns the PNG.                                                                                                                                     |

## Wire formats

See [PROTOCOL.md](./PROTOCOL.md) for the bytewise reference (XpcWrapper /
RemoteXPC handshake / DTX fragment header / aux primitives / NSKeyedArchiver
shape).

## Bringing up the tunnel by hand

```bash
DEV=63307A37-70BC-58CC-AA50-DC9432B15B19   # CoreDevice identifier from devicectl
xcrun devicectl device info ddiServices --device "$DEV"
```

After this `tunnelState` is `connected`, `ddiServicesAvailable` is `true`,
and a new `utun<N>` interface with MTU 16000 is up on the Mac. The OS
tears the tunnel down a few seconds after the last devicectl op exits;
`tunnel.ts` keeps a keeper in flight for the lifetime of a screenshot
call.

## Requirements

- macOS with Xcode 26+ command-line tools (`xcrun devicectl`, `xcrun simctl`).
- iOS 17+ device paired with the Mac (paired automatically when you open
  Xcode → Window → Devices and Simulators with the device connected once).
- Developer Mode enabled on the device (Settings → Privacy & Security →
  Developer Mode).

## Out of scope

- Simulator screenshots — those still go through `xcrun simctl io …`
  in `tools/capture.ts` and don't touch this directory.
- Input injection (tap / swipe / type) on real devices — that needs a
  different DTX service or WebDriverAgent; not started.
- iOS 16 and earlier — different transport stack.
