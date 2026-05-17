import { type Socket, createConnection } from 'node:net';

import { XpcFlags, type XpcValue, buildXpcWrapper, parseXpcWrapper } from './xpc';

// Minimal HTTP/2 client tailored to Apple's RemoteServiceDiscoveryProxy.
//
// RSD uses HTTP/2 framing but not HTTP/2 semantics:
// - no HEADERS payload (`flags: END_HEADERS`, no header blocks)
// - DATA frames carry XPC wrappers, not HTTP message bodies
//
// Node's built-in `http2` module enforces HTTP semantics, so we frame the
// bytes ourselves. The handshake we send mirrors what we observed on the
// wire from `xcrun devicectl` and `pymobiledevice3`.
//
// We're inside the encrypted CoreDevice tunnel — no TLS-PSK wrapper is
// needed. The catch: the source socket address must be the Mac end of the
// tunnel (`fd<…>::2`). Default routing picks the wrong utun on hosts with
// multiple tunnels (Tailscale, WireGuard, …).

const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

const FRAME_TYPE = {
  DATA: 0x00,
  GOAWAY: 0x07,
  HEADERS: 0x01,
  SETTINGS: 0x04,
  WINDOW_UPDATE: 0x08,
} as const;

const SETTINGS = {
  INITIAL_WINDOW_SIZE: 4,
  MAX_CONCURRENT_STREAMS: 3,
} as const;

const ROOT_CHANNEL_STREAM = 1;
const REPLY_CHANNEL_STREAM = 3;

const buildH2Frame = (type: number, flags: number, streamId: number, payload: Buffer): Buffer => {
  const header = Buffer.alloc(9);
  const length = payload.length;
  // 24-bit length, big-endian
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
  payload.writeUInt32BE(1_048_576, 8);
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

// Stream-style H2 frame parser. Holds onto a buffer of bytes; pop complete
// frames off the front as they arrive.
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

export interface RsdServiceEntry {
  /**
   * The port the service listens on inside the tunnel. RSD encodes this as
   * a string for historical reasons; we parse to number.
   */
  port: number;
  /** Optional metadata Apple ships per-service. Includes UsesRemoteXPC, EnableServiceSSL, Entitlement, etc. */
  properties: Record<string, XpcValue>;
}

export interface PeerInfo {
  /** Device-level properties (OS version, build, ECID, …). */
  properties: Record<string, XpcValue>;
  /** Service-name → entry. */
  services: Record<string, RsdServiceEntry>;
}

export class RsdHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RsdHandshakeError';
  }
}

// Walks the concatenated XpcWrapper bytes from a stream's DATA frames and
// returns the first one that contains a payload dict with a `Services` key.
const findPeerInfoDict = (stream1Bytes: Buffer): Record<string, XpcValue> | null => {
  let offset = 0;
  while (offset + 16 <= stream1Bytes.length) {
    let parsed;
    try {
      parsed = parseXpcWrapper(stream1Bytes, offset);
    } catch {
      return null;
    }
    if (parsed.totalSize <= 0 || offset + parsed.totalSize > stream1Bytes.length) return null;
    if (
      parsed.payload !== null &&
      typeof parsed.payload === 'object' &&
      !Array.isArray(parsed.payload) &&
      !Buffer.isBuffer(parsed.payload)
    ) {
      const dict = parsed.payload as Record<string, XpcValue>;
      if ('Services' in dict) return dict;
    }
    offset += parsed.totalSize;
  }
  return null;
};

const normalisePeerInfo = (dict: Record<string, XpcValue>): PeerInfo => {
  const services: Record<string, RsdServiceEntry> = {};
  const rawServices = dict.Services;
  if (
    rawServices &&
    typeof rawServices === 'object' &&
    !Array.isArray(rawServices) &&
    !Buffer.isBuffer(rawServices)
  ) {
    for (const [name, raw] of Object.entries(rawServices as Record<string, XpcValue>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Buffer.isBuffer(raw)) continue;
      const entry = raw as Record<string, XpcValue>;
      const portRaw = entry.Port;
      const port =
        typeof portRaw === 'string'
          ? Number(portRaw)
          : typeof portRaw === 'bigint'
            ? Number(portRaw)
            : NaN;
      if (!Number.isFinite(port)) continue;
      const propsRaw = entry.Properties;
      const properties =
        propsRaw &&
        typeof propsRaw === 'object' &&
        !Array.isArray(propsRaw) &&
        !Buffer.isBuffer(propsRaw)
          ? (propsRaw as Record<string, XpcValue>)
          : {};
      services[name] = { port, properties };
    }
  }
  const rawProps = dict.Properties;
  const properties =
    rawProps &&
    typeof rawProps === 'object' &&
    !Array.isArray(rawProps) &&
    !Buffer.isBuffer(rawProps)
      ? (rawProps as Record<string, XpcValue>)
      : {};
  return { properties, services };
};

export interface FetchPeerInfoOptions {
  /** Connect timeout. Default 10s. */
  timeoutMs?: number;
}

// One-shot: open a TCP connection to RSD, run the handshake, parse the
// peer_info dict, close. For long-lived RSD usage we'd factor an
// `RsdConnection` class out of this; not needed yet.
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
      // No `family: 6` here — the IPv6 literal in `host` is enough, and
      // specifying it explicitly has been observed to cause the device to
      // close the connection prematurely (got SETTINGS only, then RST).
      socket = createConnection({
        host: deviceAddress,
        localAddress: hostAddress,
        port: rsdPort,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stream1 = Buffer.alloc(0);
    const stream1Chunks: Buffer[] = [];
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

    const timer = setTimeout(() => {
      cleanup(new RsdHandshakeError(`RSD handshake timed out after ${timeoutMs}ms`));
    }, deadline - Date.now());

    socket.on('connect', () => {
      // Send the full handshake in one batch. We don't wait for the server's
      // SETTINGS first because Apple's RSD doesn't strictly require it and
      // doing it inline saves a round-trip.
      const handshake = Buffer.concat([
        HTTP2_PREFACE,
        buildSettingsFrame(),
        buildWindowUpdateFrame(0, 983041),
        buildEmptyHeadersFrame(ROOT_CHANNEL_STREAM),
        buildDataFrame(
          ROOT_CHANNEL_STREAM,
          // Send an empty XPC dict to invite the peer to publish its
          // Services list back to us. Apple's convention is to set
          // DATA_PRESENT only when the dict has keys; an empty dict ships
          // with ALWAYS_SET alone.
          buildXpcWrapper(XpcFlags.ALWAYS_SET, 0n, {})
        ),
        buildEmptyHeadersFrame(REPLY_CHANNEL_STREAM),
        buildDataFrame(
          REPLY_CHANNEL_STREAM,
          buildXpcWrapper(XpcFlags.ALWAYS_SET | XpcFlags.INIT_HANDSHAKE, 0n, null)
        ),
      ]);
      socket.write(handshake);
    });

    socket.on('data', (chunk: Buffer) => {
      reader.push(chunk);
      let frame;
      while ((frame = reader.pop()) !== null) {
        if (frame.type === FRAME_TYPE.DATA && frame.streamId === ROOT_CHANNEL_STREAM) {
          stream1Chunks.push(frame.payload);
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
      const combined = Buffer.concat([stream1, ...stream1Chunks]);
      const dict = findPeerInfoDict(combined);
      if (dict) {
        clearTimeout(timer);
        cleanup(null, normalisePeerInfo(dict));
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
