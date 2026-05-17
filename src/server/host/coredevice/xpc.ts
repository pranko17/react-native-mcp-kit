// Minimal encoder/decoder for Apple's binary XPC dictionary format.
//
// This is the on-the-wire shape of an `xpc_object_t` graph — distinct from
// XPC's mach-IPC wire format. RemoteXPC uses it inside HTTP/2 DATA frames as
// the payload of an "XpcWrapper" (see `rsd.ts`). All integers are
// little-endian; all variable-width fields are zero-padded to a 4-byte
// boundary.
//
// We don't aim for full fidelity with libxpc — only the type tags we
// actually meet on the wire when talking to the device's RSD and DTService
// hub. Easy to extend later.
//
// Reference for the wire format: PROTOCOL.md in this directory.

const TYPE_NULL = 0x00001000;
const TYPE_BOOL = 0x00002000;
const TYPE_INT64 = 0x00003000;
const TYPE_UINT64 = 0x00004000;
const TYPE_DOUBLE = 0x00005000;
const TYPE_DATA = 0x00008000;
const TYPE_STRING = 0x00009000;
const TYPE_UUID = 0x0000a000;
const TYPE_ARRAY = 0x0000e000;
const TYPE_DICTIONARY = 0x0000f000;

const pad4 = (n: number): number => {
  return (4 - (n % 4)) % 4;
};

class Reader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  remaining(): number {
    return this.buf.length - this.offset;
  }

  u32(): number {
    const value = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    const value = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  f64(): number {
    const value = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  bytes(n: number): Buffer {
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  skipPadding(unpaddedSize: number): void {
    this.offset += pad4(unpaddedSize);
  }

  position(): number {
    return this.offset;
  }

  /** Read a NUL-terminated UTF-8 string, consume the NUL, return UTF-8 text. */
  readCString(): string {
    let end = this.offset;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    if (end >= this.buf.length) {
      throw new Error(`Unterminated CString at offset ${this.offset}`);
    }
    const text = this.buf.subarray(this.offset, end).toString('utf8');
    this.offset = end + 1; // consume the NUL too
    return text;
  }
}

class Writer {
  private chunks: Buffer[] = [];
  private length = 0;

  push(buf: Buffer): void {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  u32(value: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value, 0);
    this.push(b);
  }

  u64(value: bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value, 0);
    this.push(b);
  }

  i64(value: bigint): void {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(value, 0);
    this.push(b);
  }

  f64(value: number): void {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value, 0);
    this.push(b);
  }

  bytes(buf: Buffer): void {
    this.push(buf);
  }

  pad(): void {
    const padding = pad4(this.length);
    if (padding) this.push(Buffer.alloc(padding));
  }

  size(): number {
    return this.length;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

// Public-API value types. Maps cleanly to JS but uses bigint for the 64-bit
// integer types because XPC dicts often hold values that lose precision
// past 2^53.
export type XpcValue =
  | null
  | boolean
  | bigint
  | number // doubles only
  | string
  | Buffer
  | XpcValue[]
  | { [key: string]: XpcValue };

const decodeObject = (reader: Reader): XpcValue => {
  const type = reader.u32();
  switch (type) {
    case TYPE_NULL:
      return null;
    case TYPE_BOOL:
      return reader.u32() !== 0;
    case TYPE_INT64:
      return reader.i64();
    case TYPE_UINT64:
      return reader.u64();
    case TYPE_DOUBLE:
      return reader.f64();
    case TYPE_DATA: {
      const len = reader.u32();
      const data = Buffer.from(reader.bytes(len));
      reader.skipPadding(len);
      return data;
    }
    case TYPE_STRING: {
      // length+1 is the size in bytes of the NUL-terminated UTF-8 buffer.
      const lenIncludingNul = reader.u32();
      const raw = reader.bytes(lenIncludingNul);
      reader.skipPadding(lenIncludingNul);
      // strip trailing NUL bytes (sometimes there's more than one due to
      // padding before the format was stabilised; we tolerate either).
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      return raw.subarray(0, end).toString('utf8');
    }
    case TYPE_UUID: {
      const data = reader.bytes(16);
      const hex = data.toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case TYPE_ARRAY: {
      // [length][count][entries...] — length covers count + entries.
      reader.u32();
      const count = reader.u32();
      const items: XpcValue[] = [];
      for (let i = 0; i < count; i++) items.push(decodeObject(reader));
      return items;
    }
    case TYPE_DICTIONARY: {
      // [length][count][entries...]. Each entry's key is an AlignedString —
      // a NUL-terminated UTF-8 string padded to a 4-byte boundary, NOT a
      // length-prefixed XpcString. Mixing those up is an easy bug because
      // the value side of an entry IS an XpcString-style length-prefixed
      // object.
      reader.u32();
      const count = reader.u32();
      const out: Record<string, XpcValue> = {};
      for (let i = 0; i < count; i++) {
        const start = reader.position();
        const key = reader.readCString();
        const consumed = reader.position() - start;
        reader.skipPadding(consumed);
        out[key] = decodeObject(reader);
      }
      return out;
    }
    default:
      throw new Error(`Unknown XPC type tag 0x${type.toString(16)}`);
  }
};

const encodeStringBody = (writer: Writer, value: string): void => {
  const utf8 = Buffer.from(value, 'utf8');
  const lenIncludingNul = utf8.length + 1;
  writer.u32(lenIncludingNul);
  writer.bytes(utf8);
  writer.bytes(Buffer.from([0])); // NUL terminator
  writer.pad();
};

const encodeObject = (writer: Writer, value: XpcValue): void => {
  if (value === null) {
    writer.u32(TYPE_NULL);
    return;
  }
  if (typeof value === 'boolean') {
    writer.u32(TYPE_BOOL);
    writer.u32(value ? 1 : 0);
    return;
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      writer.u32(TYPE_INT64);
      writer.i64(value);
    } else {
      writer.u32(TYPE_UINT64);
      writer.u64(value);
    }
    return;
  }
  if (typeof value === 'number') {
    writer.u32(TYPE_DOUBLE);
    writer.f64(value);
    return;
  }
  if (typeof value === 'string') {
    writer.u32(TYPE_STRING);
    encodeStringBody(writer, value);
    return;
  }
  if (Buffer.isBuffer(value)) {
    writer.u32(TYPE_DATA);
    writer.u32(value.length);
    writer.bytes(value);
    writer.pad();
    return;
  }
  if (Array.isArray(value)) {
    writer.u32(TYPE_ARRAY);
    const body = new Writer();
    body.u32(value.length); // count
    for (const item of value) encodeObject(body, item);
    const bodyBuf = body.build();
    writer.u32(bodyBuf.length);
    writer.bytes(bodyBuf);
    return;
  }
  if (typeof value === 'object') {
    writer.u32(TYPE_DICTIONARY);
    const entries = Object.entries(value);
    const body = new Writer();
    body.u32(entries.length); // count
    for (const [key, val] of entries) {
      // Entry key is AlignedString — NUL-terminated, no length prefix.
      const keyUtf8 = Buffer.from(key, 'utf8');
      body.bytes(keyUtf8);
      body.bytes(Buffer.from([0])); // NUL terminator
      const padding = pad4(keyUtf8.length + 1);
      if (padding) body.bytes(Buffer.alloc(padding));
      encodeObject(body, val);
    }
    const bodyBuf = body.build();
    writer.u32(bodyBuf.length);
    writer.bytes(bodyBuf);
    return;
  }
  throw new Error(`Cannot encode XPC value of type ${typeof value}`);
};

export const encodeXpcObject = (value: XpcValue): Buffer => {
  const writer = new Writer();
  encodeObject(writer, value);
  return writer.build();
};

export const decodeXpcObject = (buf: Buffer): XpcValue => {
  const reader = new Reader(buf);
  return decodeObject(reader);
};

// XpcWrapper is the framing around an XPC object on the RemoteXPC wire.
// Layout (little-endian throughout):
//
//   uint32 magic = 0x29B00B92
//   uint32 flags
//   uint64 messageLen  // = inner.length + 8 (see PROTOCOL.md)
//   uint64 messageId
//   if (flags & DATA_PRESENT):
//     uint32 payloadMagic = 0x42133742
//     uint32 protocolVersion = 5
//     XpcObject

export const XPC_WRAPPER_MAGIC = 0x29b00b92;
export const XPC_PAYLOAD_MAGIC = 0x42133742;
export const XPC_PAYLOAD_VERSION = 5;

export const XpcFlags = {
  ALWAYS_SET: 0x00000001,
  DATA_PRESENT: 0x00000100,
  INIT_HANDSHAKE: 0x00400000,
  PING: 0x00000002,
  REPLY: 0x00020000,
  WANTING_REPLY: 0x00010000,
} as const;

export interface XpcWrapperParsed {
  flags: number;
  messageId: bigint;
  payload: XpcValue | null;
  /** Total bytes consumed from the input buffer. */
  totalSize: number;
}

export const buildXpcWrapper = (
  flags: number,
  messageId: bigint,
  payload: XpcValue | null
): Buffer => {
  const writer = new Writer();
  writer.u32(XPC_WRAPPER_MAGIC);
  writer.u32(flags);
  // We'll patch messageLen in after we've encoded the inner part.
  const placeholder = Buffer.alloc(8);
  writer.bytes(placeholder);
  // Inner: messageId + optional payload.
  const innerStart = writer.size();
  writer.u64(messageId);
  if (payload !== null) {
    writer.u32(XPC_PAYLOAD_MAGIC);
    writer.u32(XPC_PAYLOAD_VERSION);
    writer.bytes(encodeXpcObject(payload));
  }
  const built = writer.build();
  const innerLen = built.length - innerStart;
  // On the wire the messageLen field encodes (inner_size - 8). pymd3 calls
  // this an ExprAdapter; the inverse (parse) is in `parseXpcWrapper`.
  built.writeBigUInt64LE(BigInt(innerLen - 8), 8);
  return built;
};

export const parseXpcWrapper = (buf: Buffer, offset = 0): XpcWrapperParsed => {
  const reader = new Reader(buf.subarray(offset));
  const magic = reader.u32();
  if (magic !== XPC_WRAPPER_MAGIC) {
    throw new Error(`Bad XpcWrapper magic 0x${magic.toString(16)} at offset ${offset}`);
  }
  const flags = reader.u32();
  const messageLen = reader.u64();
  // Inverse of the build side: wire value is (inner_size - 8). See PROTOCOL.md.
  const innerLen = Number(messageLen) + 8;
  const messageId = reader.u64();
  const remaining = innerLen - 8; // we consumed 8 bytes for messageId
  let payload: XpcValue | null = null;
  if (remaining >= 8) {
    const payloadMagic = reader.u32();
    if (payloadMagic !== XPC_PAYLOAD_MAGIC) {
      throw new Error(`Bad payload magic 0x${payloadMagic.toString(16)}`);
    }
    reader.u32(); // version, ignored
    if (remaining > 8) {
      const objBuf = reader.bytes(remaining - 8);
      payload = decodeXpcObject(Buffer.from(objBuf));
    }
  } else if (remaining > 0) {
    // Truncated payload; skip whatever's left.
    reader.bytes(remaining);
  }
  return {
    flags,
    messageId,
    payload,
    totalSize: 16 + innerLen,
  };
};
