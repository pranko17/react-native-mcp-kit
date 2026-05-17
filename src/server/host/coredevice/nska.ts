// NSKeyedArchiver encoder/decoder for the shapes DTX messages exchange
// with `com.apple.instruments.dtservicehub` services.
//
// NSKeyedArchiver wraps a value graph in a bplist00 with this shape:
//
//   {
//     "$archiver": "NSKeyedArchiver",
//     "$version":  100000,
//     "$top":      { "root": UID(N) },
//     "$objects":  ["$null", <object 1>, <object 2>, ...]
//   }
//
// Each complex object lives in `$objects` and references its class
// metadata (also an entry in `$objects`) via a `$class: UID(M)` field.
// Cross-references between objects are encoded as bplist UID values.
//
// Supported shapes: NSString, NSNumber, NSArray, NSDictionary, NSData
// (encode + decode), NSError + NSDate (decode only). The semantic graph
// is round-trip-equivalent with Apple's encoder; we don't dedupe leaf
// strings the way Apple does.

// eslint-disable-next-line import/no-extraneous-dependencies
import bplistCreate from 'bplist-creator';
// eslint-disable-next-line import/no-extraneous-dependencies
import bplistParse from 'bplist-parser';

const ARCHIVER_NAME = 'NSKeyedArchiver';
const ARCHIVER_VERSION = 100000;
const NULL_PLACEHOLDER = '$null';

export type NskaValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | Buffer
  | NskaValue[]
  | { [key: string]: NskaValue };

// `bplist-creator` recognises this exact shape as the UID type tag.
interface BplistUID {
  UID: number;
}

const makeUid = (index: number): BplistUID => {
  return { UID: index };
};

interface ClassDescriptor {
  classes: string[];
  classname: string;
}

const CLASS_NSARRAY: ClassDescriptor = {
  classes: ['NSArray', 'NSObject'],
  classname: 'NSArray',
};

const CLASS_NSDICTIONARY: ClassDescriptor = {
  classes: ['NSDictionary', 'NSObject'],
  classname: 'NSDictionary',
};

const CLASS_NSMUTABLEDATA: ClassDescriptor = {
  classes: ['NSMutableData', 'NSData', 'NSObject'],
  classname: 'NSMutableData',
};

class ObjectsBuilder {
  private readonly objects: unknown[] = [NULL_PLACEHOLDER];
  private readonly classCache = new Map<string, number>();

  add(obj: unknown): number {
    const idx = this.objects.length;
    this.objects.push(obj);
    return idx;
  }

  /**
   * Reserve a slot and return its index plus a `commit` that fills it in.
   * Useful when the object's content depends on UIDs of objects we're
   * about to emit (e.g. an array's NS.objects entries).
   */
  reserve(): { commit: (obj: unknown) => void; index: number } {
    const index = this.objects.length;
    this.objects.push(NULL_PLACEHOLDER);
    return {
      commit: (obj: unknown): void => {
        this.objects[index] = obj;
      },
      index,
    };
  }

  classUid(descriptor: ClassDescriptor): number {
    const cached = this.classCache.get(descriptor.classname);
    if (cached !== undefined) return cached;
    const idx = this.add({
      $classes: descriptor.classes,
      $classname: descriptor.classname,
    });
    this.classCache.set(descriptor.classname, idx);
    return idx;
  }

  finalize(): unknown[] {
    return this.objects;
  }
}

const encodeValue = (value: NskaValue, builder: ObjectsBuilder): number => {
  if (value === null) {
    return 0; // $null
  }
  if (typeof value === 'string') {
    return builder.add(value);
  }
  if (typeof value === 'bigint') {
    // bplist-creator stringifies bigints; downcast to JS number when
    // it's safe (channel codes and message ids fit comfortably).
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`bigint ${value} exceeds safe integer range for NSKA encode`);
    }
    return builder.add(Number(value));
  }
  if (typeof value === 'number') {
    return builder.add(value);
  }
  if (typeof value === 'boolean') {
    return builder.add(value);
  }
  if (Buffer.isBuffer(value)) {
    const classUid = builder.classUid(CLASS_NSMUTABLEDATA);
    return builder.add({
      $class: makeUid(classUid),
      'NS.data': value,
    });
  }
  if (Array.isArray(value)) {
    const slot = builder.reserve();
    const classUid = builder.classUid(CLASS_NSARRAY);
    const elementUids = value.map((v) => {
      return makeUid(encodeValue(v, builder));
    });
    slot.commit({
      $class: makeUid(classUid),
      'NS.objects': elementUids,
    });
    return slot.index;
  }
  if (typeof value === 'object') {
    const slot = builder.reserve();
    const classUid = builder.classUid(CLASS_NSDICTIONARY);
    const entries = Object.entries(value);
    const keyUids = entries.map(([k]) => {
      return makeUid(encodeValue(k, builder));
    });
    const valueUids = entries.map(([, v]) => {
      return makeUid(encodeValue(v, builder));
    });
    slot.commit({
      $class: makeUid(classUid),
      'NS.keys': keyUids,
      'NS.objects': valueUids,
    });
    return slot.index;
  }
  throw new Error(`Cannot NSKeyedArchive value of type ${typeof value}`);
};

export const encodeNska = (value: NskaValue): Buffer => {
  const builder = new ObjectsBuilder();
  const rootIdx = encodeValue(value, builder);
  const archive = {
    $archiver: ARCHIVER_NAME,
    $objects: builder.finalize(),
    $top: { root: makeUid(rootIdx) },
    $version: ARCHIVER_VERSION,
  };
  return bplistCreate(archive);
};

// Decoder
//
// Walks the $objects array starting from $top.root, resolving UID
// references. The shape of each "class wrapper" object tells us how to
// unwrap it: NSArray/NSDictionary look at NS.objects/NS.keys, NSData
// looks at NS.data, NSError carries NSDomain/NSCode/NSUserInfo.

interface ParsedUid {
  UID: number;
}

const isUid = (value: unknown): value is ParsedUid => {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value) &&
    typeof (value as ParsedUid).UID === 'number'
  );
};

interface ObjectWithClass {
  [key: string]: unknown;
  $class?: ParsedUid;
}

const isObjectWithClass = (value: unknown): value is ObjectWithClass => {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value)
  );
};

const classnameOf = (objects: unknown[], obj: ObjectWithClass): string | null => {
  if (!obj.$class) return null;
  const classObj = objects[obj.$class.UID];
  if (!isObjectWithClass(classObj)) return null;
  const name = classObj.$classname;
  return typeof name === 'string' ? name : null;
};

// One-time logger for NSKeyedArchive classes we don't have a dedicated
// unwrap for. Helps surface gaps in the codec without spamming on every
// reply during a long-running session.
const warnedUnknownClasses = new Set<string>();
const warnUnknownClassOnce = (name: string): void => {
  if (warnedUnknownClasses.has(name)) return;
  warnedUnknownClasses.add(name);
  // eslint-disable-next-line no-console
  console.warn(
    `[coredevice/nska] Unknown NSKA class "${name}" — falling back to raw dictionary shape. ` +
      `Add a handler in resolveValue if this should decode to a specific structure.`
  );
};

const resolveValue = (objects: unknown[], value: unknown): NskaValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value === NULL_PLACEHOLDER ? null : value;
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return value;
  if (isUid(value)) {
    return resolveValue(objects, objects[value.UID]);
  }
  if (Array.isArray(value)) {
    return value.map((v) => {
      return resolveValue(objects, v);
    });
  }
  if (isObjectWithClass(value)) {
    const name = classnameOf(objects, value);
    if (name === 'NSArray' || name === 'NSMutableArray') {
      const items = Array.isArray(value['NS.objects']) ? (value['NS.objects'] as unknown[]) : [];
      return items.map((item) => {
        return resolveValue(objects, item);
      });
    }
    if (name === 'NSDictionary' || name === 'NSMutableDictionary') {
      const keys = Array.isArray(value['NS.keys']) ? (value['NS.keys'] as unknown[]) : [];
      const vals = Array.isArray(value['NS.objects']) ? (value['NS.objects'] as unknown[]) : [];
      const out: Record<string, NskaValue> = {};
      for (let i = 0; i < keys.length; i++) {
        const key = resolveValue(objects, keys[i]);
        if (typeof key !== 'string') continue;
        out[key] = resolveValue(objects, vals[i]);
      }
      return out;
    }
    if (name === 'NSData' || name === 'NSMutableData') {
      const data = value['NS.data'];
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === 'string') return Buffer.from(data, 'binary');
      return Buffer.alloc(0);
    }
    if (name === 'NSDate') {
      const t = value['NS.time'];
      return typeof t === 'number' ? t : null;
    }
    if (name === 'NSError') {
      const out: Record<string, NskaValue> = {};
      out.domain = resolveValue(objects, value.NSDomain);
      out.code = resolveValue(objects, value.NSCode);
      out.userInfo = resolveValue(objects, value.NSUserInfo);
      return out;
    }
    if (name === 'NSNumber') {
      const n = value['NS.intval'] ?? value['NS.dblval'] ?? value['NS.bval'];
      if (typeof n === 'number' || typeof n === 'bigint' || typeof n === 'boolean') return n;
      return null;
    }
    // Unknown class — log once, return the raw shape as a dictionary, sans $class.
    if (name) warnUnknownClassOnce(name);
    const out: Record<string, NskaValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '$class') continue;
      out[k] = resolveValue(objects, v);
    }
    return out;
  }
  return null;
};

export const decodeNska = (buf: Buffer): NskaValue => {
  const [parsed] = bplistParse.parseBuffer(buf) as Array<{
    $objects: unknown[];
    $top: { root: ParsedUid };
  }>;
  if (!parsed || !parsed.$top || !parsed.$objects) {
    throw new Error('Invalid NSKeyedArchive: missing $top or $objects');
  }
  return resolveValue(parsed.$objects, parsed.$top.root);
};
