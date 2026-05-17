# Wire protocol reference

Bytewise reference for every Apple-private protocol this directory speaks.
Update this file in lockstep with the code when adding or changing
encoders/decoders.

Upstream cross-references when something seems off:

- `pymobiledevice3/dtx/structs.py` — DTX header definitions
- `pymobiledevice3/dtx/message.py` — DTX message + NSKeyedArchiver bridge
- `pymobiledevice3/remote/xpc_message.py` — XPC binary format
- `pymobiledevice3/remote/remotexpc.py` — RSD HTTP/2 handshake

## RSD — RemoteServiceDiscoveryProxy

HTTP/2 framing over plain TCP inside the CoreDevice tunnel. No TLS — the
tunnel itself is encrypted.

Source-bind requirement: the socket must originate from the Mac end of the
tunnel (`fd<prefix>::2`, taken from `ifconfig utun<N>`). Default routing on
a host with multiple tunnels (Tailscale, WireGuard, …) picks a different
utun and the device responds with `SETTINGS` once then RSTs.

The 24-byte HTTP/2 preface is the first thing on the wire:

```
PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n
```

Standard HTTP/2 frame header (9 bytes): 24-bit length, 8-bit type,
8-bit flags, 32-bit stream ID.

Handshake (one batched write):

1. Client → SETTINGS: `MAX_CONCURRENT_STREAMS=100`, `INITIAL_WINDOW_SIZE=1048576`.
2. Client → WINDOW_UPDATE (stream 0): increment = 983041.
3. Client → HEADERS (stream 1): flags = END_HEADERS, no header block.
4. Client → DATA (stream 1): an empty-dict `XpcWrapper`. Tells the peer
   to publish its Services list back on this stream.
5. Client → HEADERS (stream 3): same shape as above.
6. Client → DATA (stream 3): empty `XpcWrapper` with `INIT_HANDSHAKE` set.
7. Server → DATA on stream 1: an `XpcWrapper` whose payload is the
   `peer_info` dict containing `Services` (per-service `Port` and
   `Properties`) and `Properties` (device-level facts).

## XpcWrapper / XpcObject

Wrapper framing (little-endian throughout):

| offset | size | field |
|--------|------|-------|
| 0      | 4    | magic = 0x29B00B92 |
| 4      | 4    | flags (`XpcFlags` enum) |
| 8      | 8    | messageLen = inner_size − 8 |
| 16     | 8    | messageId (monotonic per stream) |
| 24     | …    | optional payload (see below) |

Inner = msg_id (8) + optional payload. `messageLen` is encoded as
`inner_size - 8` on the wire; decoder adds 8 back. An empty XPC dict has
`messageLen = 20` and ships with `ALWAYS_SET` alone (no `DATA_PRESENT`)
even though the payload bytes follow.

Payload prefix when present:

| offset | size | field |
|--------|------|-------|
| 0      | 4    | magic = 0x42133742 |
| 4      | 4    | protocolVersion = 5 |
| 8      | …    | XpcObject (recursive) |

XpcObject type tags (uint32 LE at object start):

```
NULL        = 0x00001000
BOOL        = 0x00002000   (followed by uint32 0/1)
INT64       = 0x00003000   (8 bytes, signed)
UINT64      = 0x00004000   (8 bytes, unsigned)
DOUBLE      = 0x00005000   (8 bytes, IEEE-754)
DATA        = 0x00008000
STRING      = 0x00009000
UUID        = 0x0000A000   (16 bytes)
ARRAY       = 0x0000E000
DICTIONARY  = 0x0000F000
```

DATA / STRING / ARRAY / DICTIONARY layouts:

```
DATA:        [type:u32][length:u32][bytes; pad to 4]
STRING:      [type:u32][lenIncludingNul:u32][NUL-terminated UTF-8; pad to 4]
ARRAY:       [type:u32][bodyLen:u32][count:u32][value; …]
DICTIONARY:  [type:u32][bodyLen:u32][count:u32][entry; …]

  entry: [AlignedString key][XpcObject value]

  AlignedString: NUL-terminated UTF-8 padded to 4 bytes — note this is NOT
  the same as XpcString, which has a u32 length prefix. Dictionary KEYS
  are AlignedString; values are XpcObject (which is length-prefixed for
  strings).
```

## DTX — Device Transport eXchange

Apple's binary RPC over TCP, the transport DTServiceHub speaks. A DTX
"message" is one or more "fragments".

Fragment header (32 bytes, little-endian):

| offset | size | field |
|--------|------|-------|
| 0      | 4    | magic = 0x1F3D5B79 |
| 4      | 4    | headerSize = 32 |
| 8      | 2    | fragmentIndex |
| 10     | 2    | fragmentCount |
| 12     | 4    | bodySize (see below) |
| 16     | 4    | identifier (monotonic per connection) |
| 20     | 4    | conversationIndex (0 = request/notify, 1+ = reply) |
| 24     | 4    | channelCode (int32 LE) |
| 28     | 4    | flags (bit 0 = EXPECTS_REPLY) |

`bodySize` semantics:
- Single-fragment message (count == 1): own body size, body follows.
- Announce fragment of a multi-fragment message (count > 1, index == 0):
  TOTAL message size (for buffer pre-allocation). No body bytes on the wire.
- Body fragment (count > 1, index ≥ 1): own body size.

Per-message header (16 bytes, present at the start of the FIRST body
fragment, little-endian):

| offset | size | field |
|--------|------|-------|
| 0      | 1    | msgType (`Ok=0, Data=1, Dispatch=2, Object=3, Error=4`) |
| 1      | 3    | reserved (zero) |
| 4      | 4    | auxSize |
| 8      | 4    | totalSize = auxSize + payloadSize |
| 12     | 4    | flags (unused on the wire) |

Followed by `auxSize` bytes of aux (DTX aux dictionary, see below) and
`totalSize - auxSize` bytes of payload (NSKeyedArchiver-encoded method
name on request, return value or NSData on reply).

Reply matching: identifiers are connection-scoped, so the reply carries
the same `identifier` and `conversationIndex == 1`. (`channelCode` of the
reply is NOT reliably the negation of the request's channel code, contrary
to some older documentation; match on identifier alone.)

## DTX aux dictionary

The format that carries a method's positional arguments. Header is 16
bytes (LE) followed by a body of `body_length` bytes.

Header:

| offset | size | field |
|--------|------|-------|
| 0      | 4    | typeAndFlags = 0x1F0 (`0x100 | 0xF0`) |
| 4      | 4    | reserved = 0 |
| 8      | 8    | body_length |

Body: `[Null key, value]` pairs (positional arguments — the key is always
the Null primitive). Each primitive starts with a uint32 type tag:

```
0x0A  Null    (tag only)
0x01  String  (uint32 length + UTF-8 bytes)
0x02  Buffer  (uint32 length + raw bytes; typically an NSKA blob)
0x03  Int32   (uint32 value)
0x06  Int64   (uint64 value)
0x09  Double  (float64 LE)
```

Plain JS values default to NSKeyedArchive-encoded Buffer primitives — that
matches Apple's "every object goes through NSKeyedArchiver" convention.
Use `dtxInt32` from `dtx.ts` when the wire type matters (channel codes
must be Int32, not NSKA blobs).

## NSKeyedArchiver

Apple's wrapper around bplist00. The top-level dict has:

```
{
  "$archiver": "NSKeyedArchiver",
  "$version":  100000,
  "$top":      { "root": UID(N) },
  "$objects":  ["$null", <object 1>, <object 2>, ...]
}
```

Each complex object lives in `$objects` and references its class metadata
(also in `$objects`) via a `$class: UID(M)` field. Cross-references are
encoded as bplist UID values.

Class shapes used by this codec:

```
NSArray / NSMutableArray
  {
    $class:       UID(M),
    "NS.objects": [UID(...), ...]
  }
  M → { $classname: "NSArray", $classes: ["NSArray", "NSObject"] }

NSDictionary / NSMutableDictionary
  {
    $class:       UID(M),
    "NS.keys":    [UID(...), ...],
    "NS.objects": [UID(...), ...]
  }

NSData / NSMutableData
  {
    $class:    UID(M),
    "NS.data": <bplist Buffer>
  }
  M → { $classname: "NSMutableData", $classes: ["NSMutableData","NSData","NSObject"] }
```

Strings and numbers are inlined into `$objects` as bplist primitives —
they don't carry `$class` metadata. The serializer doesn't dedupe leaf
strings the way Apple's encoder does, but the round-trip is
semantically equivalent and Apple's decoder accepts both shapes.

## Opening a DTX channel and taking a screenshot

After connecting to the dtservicehub port returned by RSD:

```
DTX-DISPATCH on channel 0
  payload  = NSKA("_notifyOfPublishedCapabilities:")
  aux      = DTXAux([
               NSKA({
                 "com.apple.private.DTXBlockCompression": 0,
                 "com.apple.private.DTXConnection":       1,
               })
             ])
  wantsReply = false

DTX-DISPATCH on channel 0
  payload  = NSKA("_requestChannelWithCode:identifier:")
  aux      = DTXAux([
               Int32(1),                    // the channel code we want to bind
               NSKA("com.apple.instruments.server.services.screenshot"),
             ])
  wantsReply = true

DTX-DISPATCH on channel 1
  payload  = NSKA("takeScreenshot")
  aux      = (empty)
  wantsReply = true
  reply.payload = NSKA(NSData(<PNG bytes>))
```
