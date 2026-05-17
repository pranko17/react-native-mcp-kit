import { type Socket, createConnection } from 'node:net';

import { XpcFlags, type XpcValue, buildXpcWrapper, parseXpcWrapper } from './xpc';

// HTTP/2-framed client for Apple's RemoteServiceDiscoveryProxy.
//
// RSD uses HTTP/2 framing but not HTTP/2 semantics — HEADERS frames are
// empty (`END_HEADERS` flag, no header block), DATA frames carry
// XpcWrapper payloads. Node's built-in `http2` enforces HTTP semantics
// so we frame the bytes ourselves.
//
// We're inside the encrypted CoreDevice tunnel, so no TLS wrapper is
// needed. The catch: sockets MUST source-bind to the Mac end of the
// tunnel (`fd<...>::2`, from `ifconfig utun<N>`) or kernel routing on
// hosts with multiple tunnels (Tailscale, WireGuard, …) picks the wrong
// utun and the device resets the connection.

const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

const FRAME_TYPE = {
  DATA: 0x00,
  GOAWAY: 0x07,
  HEADERS: 0x01,
  SETTINGS: 0x04,
  WINDOW_UPDATE: 0x08,
} as const;

// HTTP/2 SETTINGS identifiers (RFC 7540 §6.5.2). We only set these two —
// the rest are at peer default.
const SETTINGS = {
  INITIAL_WINDOW_SIZE: 4,
  MAX_CONCURRENT_STREAMS: 3,
} as const;

// Stream IDs used during the RSD handshake. Apple expects these specific
// numbers: stream 1 carries the peer's `peer_info` reply, stream 3 carries
// our INIT_HANDSHAKE marker. Hardcoded to mirror what `remotepairingd` does
// on the device side.
const ROOT_CHANNEL_STREAM = 1;
const REPLY_CHANNEL_STREAM = 3;

// HTTP/2 flow-control window values. `1 048 576` (1 MiB) is the per-stream
// receive window — large enough that the device doesn't pause for credit
// during the burst of XPC frames that follows. `983 041` (= 0xF0001 =
// 1 MiB − 65 535) is the connection-level WINDOW_UPDATE the connection
// preface needs to bring the default 65 535-byte window up to 1 MiB; both
// values match what Apple's client sends.
const STREAM_INITIAL_WINDOW = 1_048_576;
const CONNECTION_WINDOW_INCREMENT = 983_041;

const buildH2Frame = (type: number, flags: number, streamId: number, payload: Buffer): Buffer => {
  const header = Buffer.alloc(9);
  const length = payload.length;
  header[0] = (length >>> 16) & 0xff;
  header[1] = (length >>> 8) & 0xff;
  header[2] = length & 0xff;
  header[3] = type;
  header[4] = flags;
  header.writeUInt32BE(streamId, 5);
  return payload.length === 0 ? header : Buffer.concat([header, payload]);
};

const buildSettingsFrame = (): Buffer => {
  const payload = Buffer.alloc(12);
  payload.writeUInt16BE(SETTINGS.MAX_CONCURRENT_STREAMS, 0);
  payload.writeUInt32BE(100, 2);
  payload.writeUInt16BE(SETTINGS.INITIAL_WINDOW_SIZE, 6);
  payload.writeUInt32BE(STREAM_INITIAL_WINDOW, 8);
  return buildH2Frame(FRAME_TYPE.SETTINGS, 0x00, 0, payload);
};

const buildWindowUpdateFrame = (streamId: number, increment: number): Buffer => {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(increment, 0);
  return buildH2Frame(FRAME_TYPE.WINDOW_UPDATE, 0x00, streamId, payload);
};

const buildEmptyHeadersFrame = (streamId: number): Buffer => {
  return buildH2Frame(FRAME_TYPE.HEADERS, 0x04 /* END_HEADERS */, streamId, Buffer.alloc(0));
};

const buildDataFrame = (streamId: number, payload: Buffer): Buffer => {
  return buildH2Frame(FRAME_TYPE.DATA, 0x00, streamId, payload);
};

interface H2Frame {
  flags: number;
  payload: Buffer;
  streamId: number;
  type: number;
}

class H2FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  pop(): H2Frame | null {
    if (this.buffer.length < 9) return null;
    const length = (this.buffer[0]! << 16) | (this.buffer[1]! << 8) | this.buffer[2]!;
    if (this.buffer.length < 9 + length) return null;
    const frame: H2Frame = {
      flags: this.buffer[4]!,
      payload: this.buffer.subarray(9, 9 + length),
      streamId: this.buffer.readUInt32BE(5) & 0x7fffffff,
      type: this.buffer[3]!,
    };
    this.buffer = this.buffer.subarray(9 + length);
    return frame;
  }
}

interface RsdServiceEntry {
  /** Port the service listens on inside the tunnel. RSD encodes this as a string; we parse to number. */
  port: number;
  /** Per-service metadata: `UsesRemoteXPC`, `EnableServiceSSL`, `Entitlement`, … */
  properties: Record<string, XpcValue>;
}

export interface PeerInfo {
  /** Device-level properties (OS version, build, ECID, …). */
  properties: Record<string, XpcValue>;
  /** Service name → entry. */
  services: Record<string, RsdServiceEntry>;
}

class RsdHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RsdHandshakeError';
  }
}

// Incremental XpcWrapper parser — tracks how far we've consumed so we don't
// re-walk the prefix on every socket chunk. The peer_info reply can span
// many DATA frames; without this we'd be O(N²) in total stream-1 bytes.
class PeerInfoParser {
  private buffer = Buffer.alloc(0);
  private offset = 0;

  push(chunk: Buffer): Record<string, XpcValue> | null {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.offset + 16 <= this.buffer.length) {
      let parsed;
      try {
        parsed = parseXpcWrapper(this.buffer, this.offset);
      } catch {
        // Wrapper mid-stream; wait for more bytes.
        return null;
      }
      if (parsed.totalSize <= 0 || this.offset + parsed.totalSize > this.buffer.length) {
        return null;
      }
      this.offset += parsed.totalSize;
      const payload = parsed.payload;
      if (
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        !Buffer.isBuffer(payload) &&
        'Services' in payload
      ) {
        return payload as Record<string, XpcValue>;
      }
    }
    return null;
  }
}

const asRecord = (value: XpcValue | undefined): Record<string, XpcValue> => {
  return value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
    ? (value as Record<string, XpcValue>)
    : {};
};

const normalisePeerInfo = (dict: Record<string, XpcValue>): PeerInfo => {
  const services: Record<string, RsdServiceEntry> = {};
  for (const [name, raw] of Object.entries(asRecord(dict.Services))) {
    const entry = asRecord(raw);
    const portRaw = entry.Port;
    const port =
      typeof portRaw === 'string'
        ? Number(portRaw)
        : typeof portRaw === 'bigint'
          ? Number(portRaw)
          : NaN;
    if (!Number.isFinite(port)) continue;
    services[name] = { port, properties: asRecord(entry.Properties) };
  }
  return { properties: asRecord(dict.Properties), services };
};

interface FetchPeerInfoOptions {
  /** Connect timeout. Default 10s. */
  timeoutMs?: number;
}

// Open a TCP connection to the RSD port, run the HTTP/2 + RemoteXPC
// handshake, parse the `peer_info` dict the device sends back on stream
// 1, close.
export const fetchPeerInfo = async (
  deviceAddress: string,
  hostAddress: string,
  rsdPort: number,
  options: FetchPeerInfoOptions = {}
): Promise<PeerInfo> => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  return new Promise<PeerInfo>((resolve, reject) => {
    let socket: Socket;
    try {
      // Don't pass `family: 6` here — the IPv6 literal in `host` is
      // sufficient, and specifying it explicitly causes the device to
      // send SETTINGS once and then RST the connection.
      socket = createConnection({ host: deviceAddress, localAddress: hostAddress, port: rsdPort });
    } catch (err) {
      reject(err);
      return;
    }

    const peerParser = new PeerInfoParser();
    const reader = new H2FrameReader();
    let settled = false;

    const cleanup = (err: Error | null, value?: PeerInfo): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
      if (err) reject(err);
      else if (value) resolve(value);
    };

    const timer = setTimeout(
      () => {
        cleanup(new RsdHandshakeError(`RSD handshake timed out after ${timeoutMs}ms`));
      },
      Math.max(0, deadline - Date.now())
    );

    socket.on('connect', () => {
      // Apple's RSD accepts the whole handshake batch in one write; an
      // empty dict in the first DATA frame invites the peer to publish
      // its Services list back to us. DATA_PRESENT is set only when the
      // dict has keys; an empty dict ships with ALWAYS_SET alone.
      socket.write(
        Buffer.concat([
          HTTP2_PREFACE,
          buildSettingsFrame(),
          buildWindowUpdateFrame(0, CONNECTION_WINDOW_INCREMENT),
          buildEmptyHeadersFrame(ROOT_CHANNEL_STREAM),
          buildDataFrame(ROOT_CHANNEL_STREAM, buildXpcWrapper(XpcFlags.ALWAYS_SET, 0n, {})),
          buildEmptyHeadersFrame(REPLY_CHANNEL_STREAM),
          buildDataFrame(
            REPLY_CHANNEL_STREAM,
            buildXpcWrapper(XpcFlags.ALWAYS_SET | XpcFlags.INIT_HANDSHAKE, 0n, null)
          ),
        ])
      );
    });

    socket.on('data', (chunk: Buffer) => {
      reader.push(chunk);
      let frame: H2Frame | null;
      while ((frame = reader.pop()) !== null) {
        if (frame.type === FRAME_TYPE.DATA && frame.streamId === ROOT_CHANNEL_STREAM) {
          const dict = peerParser.push(frame.payload);
          if (dict) {
            clearTimeout(timer);
            cleanup(null, normalisePeerInfo(dict));
            return;
          }
        }
        if (frame.type === FRAME_TYPE.GOAWAY) {
          const lastStream =
            frame.payload.length >= 4 ? frame.payload.readUInt32BE(0) & 0x7fffffff : 0;
          const errorCode = frame.payload.length >= 8 ? frame.payload.readUInt32BE(4) : 0;
          cleanup(
            new RsdHandshakeError(`RSD sent GOAWAY (last_stream=${lastStream}, error=${errorCode})`)
          );
          return;
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      cleanup(err);
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        cleanup(new RsdHandshakeError('RSD socket closed before peer_info received'));
      }
    });
  });
};
