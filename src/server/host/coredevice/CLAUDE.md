# `coredevice/` — Real iOS 17+ control plane

Pure-TypeScript client that speaks Apple's RemoteXPC + DTX over the CoreDevice tunnel, so the bridge can drive real iOS 17+ devices without `pymobiledevice3`, WebDriverAgent, idb, Appium, or sudo. Reached by [`tools/capture.ts`](../tools/capture.ts) when `deviceResolver` reports a real-device target.

Already-existing standalone docs:

- **[README.md](README.md)** — what each layer does, how they compose (tunnel → RSD → DTX → `takeScreenshot`), and the constraints (Xcode CLT only, no native deps beyond `bplist-creator` / `bplist-parser`).
- **[PROTOCOL.md](PROTOCOL.md)** — bytewise wire-format reference for RSD frame layout, XpcWrapper / XpcObject codec, DTX framing + aux primitives, NSKeyedArchiver encoding. Update in lockstep with the codecs in this folder.

## File map

| File             | Role                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| [tunnel.ts](tunnel.ts)         | Keeps `xcrun devicectl device info processes` alive in the background to hold the tunnel up; resolves device IPv6 via mDNS; finds `utun<N>` for source-bind; parses RSD port from `log show`. |
| [rsd.ts](rsd.ts)               | HTTP/2-framed RemoteServiceDiscoveryProxy client; runs the handshake, returns `peer_info` with the Services dict. |
| [xpc.ts](xpc.ts)               | Binary `XpcObject` + `XpcWrapper` codec.                                                                          |
| [dtx.ts](dtx.ts)               | DTX wire framing (32-byte fragment header, multi-fragment reassembly), aux primitives, `DtxConnection` class. Reply matching by identifier, not channelCode. |
| [nska.ts](nska.ts)             | Minimal NSKeyedArchiver codec over `bplist-creator` / `bplist-parser`.                                            |
| [screenshot.ts](screenshot.ts) | `captureScreenshot(coreDeviceIdentifier)` — composes the layers (tunnel → RSD → DTX → `_notifyOfPublishedCapabilities` → `_requestChannelWithCode` → `takeScreenshot`) into PNG bytes. |

## When to edit what

- Wire-format changes: edit the codec in this folder **and** the matching section of `PROTOCOL.md`.
- New DTX service: add the channel name and method invocations to `screenshot.ts`-style helper; the framing in `dtx.ts` is generic.
- Device discovery / tunnel bring-up regression: start in `tunnel.ts` (mDNS, devicectl background-keep, log scrape) before suspecting `rsd.ts`.

Input on real devices isn't supported yet — sims go via the bundled Swift HID binary ([`../iosInput.ts`](../iosInput.ts)). When that lands here, it'll plug into a new DTX service alongside `screenshot.ts`.
