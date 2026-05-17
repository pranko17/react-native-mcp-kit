# Wire protocol reference

Distilled from pymobiledevice3 source. Apple's CoreDevice / RemoteXPC / DTX
protocols are private and undocumented — these notes are what we need to keep
this folder going across sessions. When updating an implementation file, update
the relevant section here too if the wire format changed.

Upstream files to cross-reference if something doesn't line up:
- `pymobiledevice3/dtx/structs.py`
- `pymobiledevice3/dtx/message.py`
- `pymobiledevice3/remote/xpc_message.py`
- `pymobiledevice3/remote/remotexpc.py`
- `pymobiledevice3/remote/remote_service_discovery.py`

## RSD — RemoteServiceDiscoveryProxy

Apple-flavored HTTP/2-like protocol over TCP/IPv6.

**On iOS 26 / CoreDevice tunnels the RSD port is dynamic, not 58783.** The
pymobiledevice3 default of 58783 is the legacy port and is not reachable on
modern devices. Per-tunnel observation: device opens 3-5 dynamic ports in the
49152-60000 range. Which one is RSD has to be discovered — open questions
worth following up:

- `log stream` predicate scoped to remotepairingd/CoreDeviceService for an
  explicit `RSDPort` log line on tunnel establish.
- Browse `_remoted._tcp` / `_rsd._tcp` over Bonjour scoped to the tunnel
  interface. (We saw `_remotepairing._tcp` advertise the pairing identity on
  the Wi-Fi interface but didn't get RSD on the tunnel.)
- Brute-force connect to each open port and look for an HTTP/2 SETTINGS frame
  in reply to the preface — the speaker of HTTP/2 is RSD.

Initial preface (24 bytes, ASCII):

```
PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n
```

Then standard HTTP/2 frames (9-byte header: 24-bit length, 8-bit type, 8-bit
flags, 32-bit stream ID).

Handshake on stream_id=1 (ROOT_CHANNEL):

1. Client → SETTINGS: `MAX_CONCURRENT_STREAMS=100`, `INITIAL_WINDOW_SIZE=1048576`
2. Client → WINDOW_UPDATE (stream 0): increment = 983041
3. Client → HEADERS (stream 1): flags=END_HEADERS
4. Client → DATA (stream 1): XPC wrapper with empty dict, flags=0x0201
5. Client → opens REPLY_CHANNEL (stream 3) with XpcFlags.INIT_HANDSHAKE
   (0x00400000)
6. Server → SETTINGS (must be ACK'd by client)
7. Server → DATA (stream 1): XPC dict with `peer_info` containing
   `{ Properties: {...}, Services: { <name>: { Port: <int>, Properties: {...} } } }`

The service we care about is `com.apple.instruments.dtservicehub` — its `Port`
is what we open for DTX.

## RemoteXPC — binary serialization

Wrapper (24 + payload bytes, little-endian):

| offset | size | field           |
|--------|------|-----------------|
| 0      | 4    | magic = 0x29B00B92 |
| 4      | 4    | flags (XpcFlags, bit 0 = ALWAYS_SET) |
| 8      | 8    | message_len = payload_len + 8 |
| 16     | 8    | message_id (monotonic per stream) |
| 24     | …    | payload (optional) |

Payload prefix (8 bytes):

| offset | size | field |
|--------|------|-------|
| 0      | 4    | magic = 0x42133742 |
| 4      | 4    | protocol_version = 0x00000005 |

Then a type-tagged XpcObject. Type tags (uint32 LE at object start):

```
DICTIONARY = 0x0000F000
ARRAY      = 0x0000E000
STRING     = 0x00009000
DATA       = 0x00008000
INT64      = 0x00003000
UINT64     = 0x00004000
BOOL       = 0x00002000
NULL       = 0x00001000
UUID       = 0x0000A000
DATE       = 0x00007000
DOUBLE     = 0x00005000
```

Dictionary:

```
[uint32 type=0xF000]
[uint32 total_length]
[uint32 entry_count]
For each entry:
  [uint32 key_length]
  [key:CString, padded to 4-byte boundary]
  [value:XpcObject]
```

String:

```
[uint32 type=0x9000]
[uint32 length+1]
[bytes:UTF-8 with NUL terminator, padded to 4]
```

Data (bytes):

```
[uint32 type=0x8000]
[uint32 length]
[bytes, padded to 4]
```

## DTX — Device Transport eXchange

Fragment header (32 bytes, little-endian except where noted):

| offset | size | field |
|--------|------|-------|
| 0      | 4    | magic = 0x1F3D5B79 |
| 4      | 4    | header_size (usually 32) |
| 8      | 2    | index (this fragment's number, uint16) |
| 10     | 2    | count (total fragments in message, uint16) |
| 12     | 4    | data_size (body length for this fragment) |
| 16     | 4    | identifier (message id, matches request↔reply) |
| 20     | 4    | conversation_index (0=request, 1+=reply) |
| 24     | 4    | channel_code (int32, negated if reply) |
| 28     | 4    | flags (bit 0 = EXPECTS_REPLY) |

Messages can span multiple fragments; reassemble by identifier.

Per-message payload header (16 bytes, LE):

| offset | size | field |
|--------|------|-------|
| 0      | 1    | msg_type (0=OK, 1=DATA, 2=DISPATCH, 3=OBJECT, 4=ERROR) |
| 1      | 3    | reserved (zero) |
| 4      | 4    | aux_size (uint32) |
| 8      | 4    | total_size = aux_size + payload_size (uint32) |
| 12     | 4    | flags (unused) |

Followed by:
- `aux_data` (aux_size bytes) — NSKeyedArchiver binary plist for arguments
- `payload_data` (total_size − aux_size bytes) — NSKeyedArchiver binary plist
  for return value or method name

NSKeyedArchiver wraps a bplist00 binary plist with `$archiver`, `$top`,
`$objects`, `$version` structure. We'll need a small encoder/decoder for the
specific shapes that DTServiceHub exchanges (string, NSArray of strings/ints,
NSError, NSData).

## Opening a DTServiceHub channel

After connecting to the DTServiceHub port returned by RSD:

1. Send DISPATCH on channel 0 (control channel):
   - `payload` = NSKeyedArchiver("_requestChannelWithCode:identifier:")
   - `aux` = NSKeyedArchiver([channel_code:Int32, service_name:String])
   - `flags.EXPECTS_REPLY = 1`
   - Service name example: `"com.apple.instruments.server.services.screenshot"`
2. Receive OK or OBJECT reply.
3. Device now uses `channel_code` for replies on that service. Future requests
   set their `channel_code` to the same value.

## Taking a screenshot

After opening the screenshot service channel:

1. Send DISPATCH on the screenshot channel:
   - `payload` = NSKeyedArchiver("takeScreenshot")
   - `aux` = NSKeyedArchiver([]) — empty array
2. Receive OBJECT reply with `payload` = NSKeyedArchiver(NSData) containing
   the PNG bytes.

## Key constants

```
RSD_PORT                    = 58783
DTX_FRAGMENT_MAGIC          = 0x1F3D5B79
DTX_HEADER_SIZE             = 32
DTX_MESSAGE_HEADER_SIZE     = 16
DTX_MAX_FRAGMENT_SIZE       = 128 * 1024
XPC_WRAPPER_MAGIC           = 0x29B00B92
XPC_PAYLOAD_MAGIC           = 0x42133742
XPC_PAYLOAD_VERSION         = 5
XPC_FLAGS_ALWAYS_SET        = 1 << 0
XPC_FLAGS_INIT_HANDSHAKE    = 1 << 22  // 0x00400000
HTTP2_PREFACE               = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
ROOT_CHANNEL_STREAM         = 1
REPLY_CHANNEL_STREAM        = 3
SCREENSHOT_SERVICE_NAME     = "com.apple.instruments.server.services.screenshot"
DTSERVICEHUB_SERVICE_NAME   = "com.apple.instruments.dtservicehub"
```

DTX message types:

```
OK       = 0
DATA     = 1
DISPATCH = 2
OBJECT   = 3
ERROR    = 4
```
