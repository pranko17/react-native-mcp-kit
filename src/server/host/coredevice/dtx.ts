import { createConnection, type Socket } from 'node:net';

// DTX is Apple's binary RPC over TCP, used by the Instruments stack on the
// device. We speak it on top of a connection opened to the
// `com.apple.instruments.dtservicehub` port returned by RSD.
//
// Wire format:
//
//   Fragment header (32 bytes, little-endian throughout):
//     [0..4]   magic = 0x1F3D5B79
//     [4..8]   header_size = 32
//     [8..10]  fragment_index (uint16)        ┐ multi-fragment
//     [10..12] fragment_count (uint16)        ┘ messages
//     [12..16] body_size (uint32) — this fragment's body
//     [16..20] identifier (uint32) — per-message id (monotonic per channel)
//     [20..24] conversation_index (uint32) — 0=request, 1+=reply
//     [24..28] channel_code (int32 — negative for replies)
//     [28..32] flags (uint32) — bit 0 = EXPECTS_REPLY
//
//   Per-message payload header (16 bytes, LE), present on the FIRST
//   fragment of a message only:
//     [0]      msg_type — see DtxMessageType
//     [1..4]   reserved (zero)
//     [4..8]   aux_size (uint32)
//     [8..12]  total_size = aux_size + payload_size (uint32)
//     [12..16] flags (unused)
//
//   Followed by aux_data (aux_size bytes) and payload_data
//   (total_size − aux_size bytes). Both are NSKeyedArchiver binary plists
//   carrying the method's argument array and return value (or method name
//   in the request direction).
//
// The first fragment of a multi-fragment message carries the per-message
// header and zero body bytes — `fragment_count` says how many bodies will
// follow. Subsequent fragments carry the body, indexed 1..fragment_count-1.

export const DTX_FRAGMENT_MAGIC = 0x1f3d5b79;
export const DTX_FRAGMENT_HEADER_SIZE = 32;
export const DTX_MESSAGE_HEADER_SIZE = 16;
export const DTX_MAX_FRAGMENT_BODY = 64 * 1024;

export enum DtxMessageType {
  Ok = 0,
  Data = 1,
  Dispatch = 2,
  Object = 3,
  Error = 4,
}

export interface DtxFragmentHeader {
  bodySize: number;
  channelCode: number;
  conversationIndex: number;
  flags: number;
  fragmentCount: number;
  fragmentIndex: number;
  identifier: number;
}

export const DTX_FLAGS = {
  ExpectsReply: 1 << 0,
} as const;

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
  const magic = buf.readUInt32LE(offset + 0);
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

export interface DtxMessageHeader {
  auxSize: number;
  flags: number;
  msgType: DtxMessageType;
  totalSize: number;
}

const writeMessageHeader = (h: DtxMessageHeader): Buffer => {
  const buf = Buffer.alloc(DTX_MESSAGE_HEADER_SIZE);
  buf.writeUInt8(h.msgType, 0);
  // bytes 1..3 are reserved and stay zero
  buf.writeUInt32LE(h.auxSize, 4);
  buf.writeUInt32LE(h.totalSize, 8);
  buf.writeUInt32LE(h.flags, 12);
  return buf;
};

const parseMessageHeader = (buf: Buffer, offset = 0): DtxMessageHeader => {
  return {
    auxSize: buf.readUInt32LE(offset + 4),
    flags: buf.readUInt32LE(offset + 12),
    msgType: buf.readUInt8(offset + 0) as DtxMessageType,
    totalSize: buf.readUInt32LE(offset + 8),
  };
};

export interface DtxMessage {
  /** NSKeyedArchiver-serialized argument array. */
  aux: Buffer;
  channelCode: number;
  conversationIndex: number;
  /** Carries `flags.EXPECTS_REPLY` from the fragment header. */
  flags: number;
  identifier: number;
  msgType: DtxMessageType;
  /** NSKeyedArchiver-serialized return value or selector. */
  payload: Buffer;
}

// Builds a DTX message into one or more fragments and concatenates them
// into a single buffer ready to write to the socket.
export const buildDtxMessage = (
  msg: Omit<DtxMessage, 'aux' | 'payload'> & {
    aux: Buffer;
    payload: Buffer;
  }
): Buffer => {
  const messageHeader = writeMessageHeader({
    auxSize: msg.aux.length,
    flags: 0,
    msgType: msg.msgType,
    totalSize: msg.aux.length + msg.payload.length,
  });
  const body = Buffer.concat([messageHeader, msg.aux, msg.payload]);
  if (body.length <= DTX_MAX_FRAGMENT_BODY) {
    // Single-fragment fast path.
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

  // Multi-fragment path. The first fragment carries the per-message header
  // and ZERO body bytes; it announces the fragment count. Subsequent
  // fragments carry equal-sized body chunks (the last one may be smaller).
  const bodyChunks: Buffer[] = [];
  for (let off = 0; off < body.length; off += DTX_MAX_FRAGMENT_BODY) {
    bodyChunks.push(body.subarray(off, Math.min(off + DTX_MAX_FRAGMENT_BODY, body.length)));
  }
  const fragmentCount = bodyChunks.length + 1;
  const fragments: Buffer[] = [];
  fragments.push(
    writeFragmentHeader({
      bodySize: 0,
      channelCode: msg.channelCode,
      conversationIndex: msg.conversationIndex,
      flags: msg.flags,
      fragmentCount,
      fragmentIndex: 0,
      identifier: msg.identifier,
    })
  );
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

// Stream-style fragment reader. Push raw socket bytes in, pull complete
// `DtxMessage` values out as they're reassembled. Multi-fragment messages
// are buffered per-identifier until the last fragment lands.
export class DtxReader {
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { fragments: Buffer[]; header: DtxFragmentHeader }>();

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Pull the next complete message off the buffer, or null if there isn't one yet. */
  next(): DtxMessage | null {
    while (this.buffer.length >= DTX_FRAGMENT_HEADER_SIZE) {
      const header = parseFragmentHeader(this.buffer);
      const totalLength = DTX_FRAGMENT_HEADER_SIZE + header.bodySize;
      if (this.buffer.length < totalLength) return null;
      const body = this.buffer.subarray(DTX_FRAGMENT_HEADER_SIZE, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      if (header.fragmentCount === 1) {
        return this.assemble([body], header);
      }

      if (header.fragmentIndex === 0) {
        // Announce fragment — body should be empty (sanity).
        this.pending.set(header.identifier, { fragments: [], header });
        continue;
      }

      const slot = this.pending.get(header.identifier);
      if (!slot) {
        // We never saw the announce fragment. Treat as a single-fragment
        // recovery rather than throwing, so a single decode bug doesn't
        // bring down the connection.
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
        `DTX message totalSize ${msgHeader.totalSize} exceeds body length ${body.length - DTX_MESSAGE_HEADER_SIZE}`
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

// Higher-level connection wrapper. Owns a TCP socket to dtservicehub,
// tracks outgoing message identifiers and pending replies, and dispatches
// incoming messages to whoever's waiting.
//
// Channels: a fresh DTX connection has only the implicit control channel
// (code 0). To open additional service channels — e.g.
// `com.apple.instruments.server.services.screenshot` — caller invokes
// `_requestChannelWithCode:identifier:` on channel 0 and gets back the
// new channel code. We don't model channels with classes here; this layer
// just gives you `invoke(channelCode, payload, aux)` and you handle the
// channel-opening machinery one level up.

export interface DtxOpenOptions {
  /** Connect timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export interface DtxInvokeOptions {
  /** Per-channel monotonic identifier. Caller supplies the next value. */
  identifier: number;
  /**
   * Set when the caller is interested in the reply. We always wait for a
   * reply when this is true; if false, `invoke` resolves once the message
   * is on the wire.
   */
  wantsReply?: boolean;
}

export class DtxConnectionError extends Error {
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
  /** Async listeners that aren't waiting on a specific reply. */
  private readonly listeners = new Set<(msg: DtxMessage) => void>();
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

  /** Subscribe to messages that aren't matched as replies to outstanding invokes. */
  onMessage(handler: (msg: DtxMessage) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  send(message: {
    aux: Buffer;
    channelCode: number;
    conversationIndex: number;
    flags: number;
    identifier: number;
    msgType: DtxMessageType;
    payload: Buffer;
  }): void {
    if (this.closed) {
      throw new DtxConnectionError('DTX connection is closed');
    }
    this.socket.write(buildDtxMessage(message));
  }

  /**
   * Send a DISPATCH message and (optionally) await the reply. The reply
   * is matched on (channelCode, identifier) — replies have negated
   * channel codes and conversation_index > 0.
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
    const flags = wantsReply ? DTX_FLAGS.ExpectsReply : 0;
    const key = `${channelCode}:${options.identifier}`;

    const replyPromise = wantsReply
      ? new Promise<DtxMessage>((resolve, reject) => {
          this.pendingReplies.set(key, { reject, resolve });
        })
      : null;

    this.send({
      aux,
      channelCode,
      conversationIndex: 0,
      flags,
      identifier: options.identifier,
      msgType: DtxMessageType.Dispatch,
      payload,
    });

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
    if (msg.conversationIndex > 0) {
      // Replies have the channel_code negated by the device.
      const key = `${-msg.channelCode}:${msg.identifier}`;
      const slot = this.pendingReplies.get(key);
      if (slot) {
        this.pendingReplies.delete(key);
        if (msg.msgType === DtxMessageType.Error) {
          slot.reject(
            new DtxConnectionError(`DTX peer returned error message (id=${msg.identifier})`)
          );
        } else {
          slot.resolve(msg);
        }
        return;
      }
    }
    // Either a peer-initiated message or a reply with no waiter. Forward
    // to listeners so the caller can route it themselves.
    for (const listener of this.listeners) {
      listener(msg);
    }
  }

  private failAllPending(err: Error): void {
    for (const slot of this.pendingReplies.values()) {
      slot.reject(err);
    }
    this.pendingReplies.clear();
  }
}
