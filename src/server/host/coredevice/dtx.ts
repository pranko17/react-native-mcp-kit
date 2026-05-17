import { type Socket, createConnection } from 'node:net';

import { type NskaValue, encodeNska } from './nska';

// DTX is Apple's binary RPC over TCP, used by the Instruments stack on the
// device. We speak it on top of a connection opened to the
// `com.apple.instruments.dtservicehub` port returned by RSD.
//
// Wire format is documented in PROTOCOL.md. In short: each message is one
// or more fragments. A fragment is a 32-byte header followed by an
// optional body. The first fragment of a multi-fragment message carries
// the TOTAL assembled body size in its `bodySize` header field and no
// body bytes; subsequent fragments carry their own chunk of the body.
// The first body chunk begins with a 16-byte per-message header whose
// `aux_size` and `total_size` describe the NSKeyedArchiver-encoded
// argument and payload sections.

const DTX_FRAGMENT_MAGIC = 0x1f3d5b79;
const DTX_FRAGMENT_HEADER_SIZE = 32;
const DTX_MESSAGE_HEADER_SIZE = 16;
const DTX_MAX_FRAGMENT_BODY = 64 * 1024;
const DTX_FLAG_EXPECTS_REPLY = 1 << 0;

export enum DtxMessageType {
  Ok = 0,
  Data = 1,
  Dispatch = 2,
  Object = 3,
  Error = 4,
}

interface DtxFragmentHeader {
  bodySize: number;
  channelCode: number;
  conversationIndex: number;
  flags: number;
  fragmentCount: number;
  fragmentIndex: number;
  identifier: number;
}

const writeFragmentHeader = (h: DtxFragmentHeader): Buffer => {
  const buf = Buffer.alloc(DTX_FRAGMENT_HEADER_SIZE);
  buf.writeUInt32LE(DTX_FRAGMENT_MAGIC, 0);
  buf.writeUInt32LE(DTX_FRAGMENT_HEADER_SIZE, 4);
  buf.writeUInt16LE(h.fragmentIndex, 8);
  buf.writeUInt16LE(h.fragmentCount, 10);
  buf.writeUInt32LE(h.bodySize, 12);
  buf.writeUInt32LE(h.identifier, 16);
  buf.writeUInt32LE(h.conversationIndex, 20);
  buf.writeInt32LE(h.channelCode, 24);
  buf.writeUInt32LE(h.flags, 28);
  return buf;
};

const parseFragmentHeader = (buf: Buffer, offset = 0): DtxFragmentHeader => {
  const magic = buf.readUInt32LE(offset);
  if (magic !== DTX_FRAGMENT_MAGIC) {
    throw new Error(`Bad DTX fragment magic 0x${magic.toString(16)} at offset ${offset}`);
  }
  const headerSize = buf.readUInt32LE(offset + 4);
  if (headerSize !== DTX_FRAGMENT_HEADER_SIZE) {
    throw new Error(`Unexpected DTX fragment header size ${headerSize}`);
  }
  return {
    bodySize: buf.readUInt32LE(offset + 12),
    channelCode: buf.readInt32LE(offset + 24),
    conversationIndex: buf.readUInt32LE(offset + 20),
    flags: buf.readUInt32LE(offset + 28),
    fragmentCount: buf.readUInt16LE(offset + 10),
    fragmentIndex: buf.readUInt16LE(offset + 8),
    identifier: buf.readUInt32LE(offset + 16),
  };
};

interface DtxMessageHeader {
  auxSize: number;
  flags: number;
  msgType: DtxMessageType;
  totalSize: number;
}

const writeMessageHeader = (h: DtxMessageHeader): Buffer => {
  const buf = Buffer.alloc(DTX_MESSAGE_HEADER_SIZE);
  buf.writeUInt8(h.msgType, 0);
  // bytes 1..3 reserved
  buf.writeUInt32LE(h.auxSize, 4);
  buf.writeUInt32LE(h.totalSize, 8);
  buf.writeUInt32LE(h.flags, 12);
  return buf;
};

const parseMessageHeader = (buf: Buffer): DtxMessageHeader => {
  return {
    auxSize: buf.readUInt32LE(4),
    flags: buf.readUInt32LE(12),
    msgType: buf.readUInt8(0) as DtxMessageType,
    totalSize: buf.readUInt32LE(8),
  };
};

export interface DtxMessage {
  aux: Buffer;
  channelCode: number;
  conversationIndex: number;
  flags: number;
  identifier: number;
  msgType: DtxMessageType;
  payload: Buffer;
}

const buildDtxMessage = (msg: DtxMessage): Buffer => {
  const messageHeader = writeMessageHeader({
    auxSize: msg.aux.length,
    flags: 0,
    msgType: msg.msgType,
    totalSize: msg.aux.length + msg.payload.length,
  });
  const body = Buffer.concat([messageHeader, msg.aux, msg.payload]);

  if (body.length <= DTX_MAX_FRAGMENT_BODY) {
    return Buffer.concat([
      writeFragmentHeader({
        bodySize: body.length,
        channelCode: msg.channelCode,
        conversationIndex: msg.conversationIndex,
        flags: msg.flags,
        fragmentCount: 1,
        fragmentIndex: 0,
        identifier: msg.identifier,
      }),
      body,
    ]);
  }

  const bodyChunks: Buffer[] = [];
  for (let off = 0; off < body.length; off += DTX_MAX_FRAGMENT_BODY) {
    bodyChunks.push(body.subarray(off, Math.min(off + DTX_MAX_FRAGMENT_BODY, body.length)));
  }
  const fragmentCount = bodyChunks.length + 1;
  const fragments: Buffer[] = [
    // Announce fragment: bodySize = TOTAL message size, no body bytes on the wire.
    writeFragmentHeader({
      bodySize: body.length,
      channelCode: msg.channelCode,
      conversationIndex: msg.conversationIndex,
      flags: msg.flags,
      fragmentCount,
      fragmentIndex: 0,
      identifier: msg.identifier,
    }),
  ];
  for (let i = 0; i < bodyChunks.length; i++) {
    fragments.push(
      writeFragmentHeader({
        bodySize: bodyChunks[i]!.length,
        channelCode: msg.channelCode,
        conversationIndex: msg.conversationIndex,
        flags: msg.flags,
        fragmentCount,
        fragmentIndex: i + 1,
        identifier: msg.identifier,
      }),
      bodyChunks[i]!
    );
  }
  return Buffer.concat(fragments);
};

// Stream parser: push raw socket bytes in, pull reassembled `DtxMessage`s
// out. Multi-fragment messages are buffered per-identifier until the
// last body fragment lands.
class DtxReader {
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { fragments: Buffer[]; header: DtxFragmentHeader }>();

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  next(): DtxMessage | null {
    while (this.buffer.length >= DTX_FRAGMENT_HEADER_SIZE) {
      const header = parseFragmentHeader(this.buffer);
      const isAnnounce = header.fragmentCount > 1 && header.fragmentIndex === 0;
      const onWireBodySize = isAnnounce ? 0 : header.bodySize;
      const totalLength = DTX_FRAGMENT_HEADER_SIZE + onWireBodySize;
      if (this.buffer.length < totalLength) return null;

      const body = isAnnounce
        ? Buffer.alloc(0)
        : this.buffer.subarray(DTX_FRAGMENT_HEADER_SIZE, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      if (header.fragmentCount === 1) {
        return this.assemble([body], header);
      }

      if (isAnnounce) {
        this.pending.set(header.identifier, { fragments: [], header });
        continue;
      }

      const slot = this.pending.get(header.identifier);
      if (!slot) {
        // No announce was registered — treat as a one-off so a single
        // decode hiccup doesn't bring the connection down.
        return this.assemble([body], header);
      }
      slot.fragments.push(body);
      if (slot.fragments.length === slot.header.fragmentCount - 1) {
        this.pending.delete(header.identifier);
        return this.assemble(slot.fragments, slot.header);
      }
    }
    return null;
  }

  private assemble(bodyChunks: Buffer[], header: DtxFragmentHeader): DtxMessage {
    const body = bodyChunks.length === 1 ? bodyChunks[0]! : Buffer.concat(bodyChunks);
    if (body.length < DTX_MESSAGE_HEADER_SIZE) {
      throw new Error(`DTX message body shorter than header (${body.length} bytes)`);
    }
    const msgHeader = parseMessageHeader(body);
    if (msgHeader.totalSize > body.length - DTX_MESSAGE_HEADER_SIZE) {
      throw new Error(
        `DTX message totalSize ${msgHeader.totalSize} exceeds body length ${
          body.length - DTX_MESSAGE_HEADER_SIZE
        }`
      );
    }
    const aux = body.subarray(DTX_MESSAGE_HEADER_SIZE, DTX_MESSAGE_HEADER_SIZE + msgHeader.auxSize);
    const payload = body.subarray(
      DTX_MESSAGE_HEADER_SIZE + msgHeader.auxSize,
      DTX_MESSAGE_HEADER_SIZE + msgHeader.totalSize
    );
    return {
      aux,
      channelCode: header.channelCode,
      conversationIndex: header.conversationIndex,
      flags: header.flags,
      identifier: header.identifier,
      msgType: msgHeader.msgType,
      payload,
    };
  }
}

// DTX aux dictionary — a typed-primitive list that carries a method's
// positional arguments. Wire layout:
//
//   uint32 type_and_flags = 0x1F0
//   uint32 reserved       = 0
//   uint64 body_length    bytes following this header
//   <body>
//     For each positional arg:
//       <Null primitive>     (key — positional convention)
//       <value primitive>    (one of the tagged primitives below)
//
// Primitive tags (uint32):
//   0x0A  Null    (tag only)
//   0x01  String  (uint32 length + utf-8 bytes)
//   0x02  Buffer  (uint32 length + raw bytes; usually an NSKA blob)
//   0x03  Int32   (uint32 value)
//   0x06  Int64   (uint64 value)
//   0x09  Double  (float64 LE)
//
// A plain JS value handed to `buildDtxAux` defaults to an NSKA-encoded
// Buffer primitive — that matches Apple's "every object goes through
// NSKeyedArchiver" convention. Use `dtxInt32` (or future helpers) when
// the wire type matters; channel codes for instance must be Int32, not
// NSKA buffers.

const DTX_AUX_DICT_MAGIC = 0x000001f0;

type Primitive =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'buffer'; value: Buffer }
  | { kind: 'int32'; value: number }
  | { kind: 'int64'; value: bigint }
  | { kind: 'double'; value: number };

const writePrimitive = (chunks: Buffer[], p: Primitive): void => {
  switch (p.kind) {
    case 'null': {
      const h = Buffer.alloc(4);
      h.writeUInt32LE(0x0a, 0);
      chunks.push(h);
      return;
    }
    case 'string': {
      const utf8 = Buffer.from(p.value, 'utf8');
      const h = Buffer.alloc(8);
      h.writeUInt32LE(0x01, 0);
      h.writeUInt32LE(utf8.length, 4);
      chunks.push(h, utf8);
      return;
    }
    case 'buffer': {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(0x02, 0);
      h.writeUInt32LE(p.value.length, 4);
      chunks.push(h, p.value);
      return;
    }
    case 'int32': {
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(0x03, 0);
      buf.writeInt32LE(p.value, 4);
      chunks.push(buf);
      return;
    }
    case 'int64': {
      const buf = Buffer.alloc(12);
      buf.writeUInt32LE(0x06, 0);
      buf.writeBigInt64LE(p.value, 4);
      chunks.push(buf);
      return;
    }
    case 'double': {
      const buf = Buffer.alloc(12);
      buf.writeUInt32LE(0x09, 0);
      buf.writeDoubleLE(p.value, 4);
      chunks.push(buf);
      return;
    }
  }
};

export const dtxInt32 = (value: number): Primitive => {
  return { kind: 'int32', value };
};

const argToPrimitive = (arg: NskaValue | Primitive): Primitive => {
  if (
    arg &&
    typeof arg === 'object' &&
    !Buffer.isBuffer(arg) &&
    !Array.isArray(arg) &&
    'kind' in arg &&
    typeof (arg as { kind: unknown }).kind === 'string'
  ) {
    return arg as Primitive;
  }
  return { kind: 'buffer', value: encodeNska(arg as NskaValue) };
};

export const buildDtxAux = (args: ReadonlyArray<NskaValue | Primitive>): Buffer => {
  if (args.length === 0) return Buffer.alloc(0);
  const bodyChunks: Buffer[] = [];
  for (const arg of args) {
    writePrimitive(bodyChunks, { kind: 'null' });
    writePrimitive(bodyChunks, argToPrimitive(arg));
  }
  const body = Buffer.concat(bodyChunks);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(DTX_AUX_DICT_MAGIC, 0);
  header.writeUInt32LE(0, 4);
  header.writeBigUInt64LE(BigInt(body.length), 8);
  return Buffer.concat([header, body]);
};

// DTX connection wrapper. Owns a TCP socket to dtservicehub, tracks
// outgoing identifiers and pending replies, and dispatches incoming
// messages to whoever's waiting.

export interface DtxOpenOptions {
  /** Connect timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export interface DtxInvokeOptions {
  /** Connection-scoped monotonic identifier. Caller picks the next value. */
  identifier: number;
  /**
   * When true (the default), invoke resolves with the reply DTX message.
   * When false, invoke resolves once the message is on the wire and
   * never reads from the socket for this call.
   */
  wantsReply?: boolean;
}

class DtxConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DtxConnectionError';
  }
}

export class DtxConnection {
  private readonly reader = new DtxReader();
  private readonly pendingReplies = new Map<
    string,
    { reject: (err: Error) => void; resolve: (msg: DtxMessage) => void }
  >();
  private closed = false;
  private socketError: Error | null = null;

  constructor(private readonly socket: Socket) {
    this.socket.on('data', (chunk: Buffer) => {
      this.handleChunk(chunk);
    });
    this.socket.on('error', (err) => {
      this.socketError = err;
      this.failAllPending(err);
    });
    this.socket.on('close', () => {
      this.closed = true;
      if (!this.socketError) {
        this.failAllPending(new DtxConnectionError('DTX socket closed'));
      }
    });
  }

  static async open(
    deviceAddress: string,
    hostAddress: string,
    port: number,
    options: DtxOpenOptions = {}
  ): Promise<DtxConnection> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = createConnection({
      host: deviceAddress,
      localAddress: hostAddress,
      port,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new DtxConnectionError(
            `DTX connect to [${deviceAddress}]:${port} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return new DtxConnection(socket);
  }

  /**
   * Send a DISPATCH message and optionally await the reply. Replies are
   * matched by identifier — connection-scoped, so the caller only has to
   * keep them unique across all channels on this connection.
   */
  invoke(
    channelCode: number,
    payload: Buffer,
    aux: Buffer,
    options: DtxInvokeOptions
  ): Promise<DtxMessage | null> {
    if (this.closed) {
      return Promise.reject(new DtxConnectionError('DTX connection is closed'));
    }
    const wantsReply = options.wantsReply ?? true;
    const flags = wantsReply ? DTX_FLAG_EXPECTS_REPLY : 0;
    const key = String(options.identifier);

    const replyPromise = wantsReply
      ? new Promise<DtxMessage>((resolve, reject) => {
          this.pendingReplies.set(key, { reject, resolve });
        })
      : null;

    this.socket.write(
      buildDtxMessage({
        aux,
        channelCode,
        conversationIndex: 0,
        flags,
        identifier: options.identifier,
        msgType: DtxMessageType.Dispatch,
        payload,
      })
    );

    return wantsReply ? replyPromise! : Promise.resolve(null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // best-effort
    }
    this.failAllPending(new DtxConnectionError('DTX connection closed by caller'));
  }

  private handleChunk(chunk: Buffer): void {
    this.reader.push(chunk);
    for (;;) {
      let msg: DtxMessage | null;
      try {
        msg = this.reader.next();
      } catch (err) {
        this.failAllPending(err as Error);
        this.close();
        return;
      }
      if (!msg) return;
      this.dispatch(msg);
    }
  }

  private dispatch(msg: DtxMessage): void {
    if (msg.conversationIndex === 0) return; // peer-initiated, no waiter
    const slot = this.pendingReplies.get(String(msg.identifier));
    if (!slot) return;
    this.pendingReplies.delete(String(msg.identifier));
    if (msg.msgType === DtxMessageType.Error) {
      slot.reject(new DtxConnectionError(`DTX peer returned error message (id=${msg.identifier})`));
    } else {
      slot.resolve(msg);
    }
  }

  private failAllPending(err: Error): void {
    for (const slot of this.pendingReplies.values()) {
      slot.reject(err);
    }
    this.pendingReplies.clear();
  }
}
