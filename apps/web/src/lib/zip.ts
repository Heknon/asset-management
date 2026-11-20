/**
 * A small zip writer and reader for backup files, on the browser's own
 * (de)compression streams: no size limit from holding the archive in memory
 * as one buffer (documents stay Blobs), and ZIP64 when the archive outgrows
 * 4 GB or 65,535 entries. Reads archives made by ordinary zip tools too
 * (stored or deflated entries).
 */

import { crc32Update } from '@am/core';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const UTF8_NAMES = 0x0800;

/** CRC-32 of a Blob, read in pieces. */
export async function crc32(data: Blob): Promise<number> {
  let c = MAX32;
  const reader = data.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    c = crc32Update(c, value);
  }
  return (c ^ MAX32) >>> 0;
}

const canDeflate = typeof CompressionStream !== 'undefined';
const canInflate = typeof DecompressionStream !== 'undefined';

const through = (data: Blob, stream: GenericTransformStream) => new Response(data.stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>)).blob();

/** A little-endian record being filled in. */
class Record {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(v: number) {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number) {
    this.view.setUint32(this.at, v, true);
    this.at += 4;
    return this;
  }
  u64(v: number) {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
    return this;
  }
  raw(b: Uint8Array) {
    this.bytes.set(b, this.at);
    this.at += b.length;
    return this;
  }
}

interface Written {
  name: Uint8Array;
  method: number;
  crc: number;
  size: number;
  packed: number;
  offset: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** ZIP64 extra field carrying the values that do not fit in 32 bits, in the order the format prescribes. */
function zip64Extra(values: number[]): Uint8Array {
  if (!values.length) return new Uint8Array(0);
  const r = new Record(4 + values.length * 8).u16(0x0001).u16(values.length * 8);
  values.forEach((v) => r.u64(v));
  return r.bytes;
}

export class ZipWriter {
  private readonly parts: Blob[] = [];
  private readonly entries: Written[] = [];
  private offset = 0;
  private readonly stamp = dosDateTime(new Date());

  /** `zip64: true` forces the large-archive records (for tests); otherwise they appear only when needed. */
  constructor(private readonly opts: { zip64?: boolean } = {}) {}

  private push(part: Uint8Array | Blob) {
    const blob = part instanceof Blob ? part : new Blob([part as BlobPart]);
    this.parts.push(blob);
    this.offset += blob.size;
  }

  /** Adds a file. Text compresses well; documents (already compressed formats, mostly) are stored as they are. */
  async add(name: string, data: Blob | string, { compress = typeof data === 'string' }: { compress?: boolean } = {}): Promise<void> {
    const blob = typeof data === 'string' ? new Blob([data]) : data;
    const crc = await crc32(blob);
    let packed = blob;
    let method = 0;
    if (compress && canDeflate && blob.size) {
      const deflated = await through(blob, new CompressionStream('deflate-raw'));
      if (deflated.size < blob.size) {
        packed = deflated;
        method = 8;
      }
    }
    const nameBytes = new TextEncoder().encode(name);
    const big = this.opts.zip64 || blob.size >= MAX32 || packed.size >= MAX32;
    const extra = big ? zip64Extra([blob.size, packed.size]) : new Uint8Array(0);
    const entry: Written = { name: nameBytes, method, crc, size: blob.size, packed: packed.size, offset: this.offset };
    this.push(
      new Record(30 + nameBytes.length + extra.length)
        .u32(LOCAL)
        .u16(big ? 45 : 20)
        .u16(UTF8_NAMES)
        .u16(method)
        .u16(this.stamp.time)
        .u16(this.stamp.date)
        .u32(crc)
        .u32(big ? MAX32 : packed.size)
        .u32(big ? MAX32 : blob.size)
        .u16(nameBytes.length)
        .u16(extra.length)
        .raw(nameBytes)
        .raw(extra).bytes,
    );
    this.push(packed);
    this.entries.push(entry);
  }

  /** Writes the directory and returns the archive. */
  finish(): Blob {
    const start = this.offset;
    for (const e of this.entries) {
      const force = !!this.opts.zip64;
      const big = [...(force || e.size >= MAX32 ? [e.size] : []), ...(force || e.packed >= MAX32 ? [e.packed] : []), ...(force || e.offset >= MAX32 ? [e.offset] : [])];
      const extra = zip64Extra(big);
      this.push(
        new Record(46 + e.name.length + extra.length)
          .u32(CENTRAL)
          .u16(big.length ? 45 : 20)
          .u16(big.length ? 45 : 20)
          .u16(UTF8_NAMES)
          .u16(e.method)
          .u16(this.stamp.time)
          .u16(this.stamp.date)
          .u32(e.crc)
          .u32(force || e.packed >= MAX32 ? MAX32 : e.packed)
          .u32(force || e.size >= MAX32 ? MAX32 : e.size)
          .u16(e.name.length)
          .u16(extra.length)
          .u16(0)
          .u16(0)
          .u16(0)
          .u32(0)
          .u32(force || e.offset >= MAX32 ? MAX32 : e.offset)
          .raw(e.name)
          .raw(extra).bytes,
      );
    }
    const size = this.offset - start;
    const count = this.entries.length;
    const big = this.opts.zip64 || count >= MAX16 || size >= MAX32 || start >= MAX32;
    if (big) {
      const at = this.offset;
      this.push(new Record(56).u32(END64).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(size).u64(start).bytes);
      this.push(new Record(20).u32(LOCATOR64).u32(0).u64(at).u32(1).bytes);
    }
    this.push(
      new Record(22)
        .u32(END)
        .u16(0)
        .u16(0)
        .u16(big ? MAX16 : count)
        .u16(big ? MAX16 : count)
        .u32(big ? MAX32 : size)
        .u32(big ? MAX32 : start)
        .u16(0).bytes,
    );
    return new Blob(this.parts, { type: 'application/zip' });
  }
}

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  size: number;
  /** The file's contents, checked against its checksum. */
  blob(): Promise<Blob>;
  text(): Promise<string>;
}

const view = async (file: Blob, from: number, to: number) => new DataView(await file.slice(from, to).arrayBuffer());
const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

/** Opens a zip for random access: only the directory is read now, entries when asked for. */
export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const notZip = new ZipError('Not a zip file');
  if (file.size < 22) throw notZip;
  // The end record sits at the very end, before an optional comment of up to 64 KB.
  const tailStart = Math.max(0, file.size - 22 - MAX16);
  const tail = await view(file, tailStart, file.size);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw notZip;
  let count = tail.getUint16(end + 10, true);
  let size = tail.getUint32(end + 12, true);
  let start = tail.getUint32(end + 16, true);
  if (count === MAX16 || size === MAX32 || start === MAX32) {
    const locatorAt = tailStart + end - 20;
    if (locatorAt < 0) throw notZip;
    const locator = await view(file, locatorAt, locatorAt + 20);
    if (locator.getUint32(0, true) !== LOCATOR64) throw notZip;
    const at = u64(locator, 8);
    const record = await view(file, at, at + 56);
    if (record.getUint32(0, true) !== END64) throw notZip;
    count = u64(record, 32);
    size = u64(record, 40);
    start = u64(record, 48);
  }
  if (start + size > file.size) throw notZip;

  const dir = await view(file, start, start + size);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > dir.byteLength || dir.getUint32(at, true) !== CENTRAL) throw new ZipError('The zip file is damaged (its directory cannot be read)');
    const flags = dir.getUint16(at + 8, true);
    const method = dir.getUint16(at + 10, true);
    const crc = dir.getUint32(at + 16, true);
    let packed = dir.getUint32(at + 20, true);
    let unpacked = dir.getUint32(at + 24, true);
    const nameLength = dir.getUint16(at + 28, true);
    const extraLength = dir.getUint16(at + 30, true);
    const commentLength = dir.getUint16(at + 32, true);
    let offset = dir.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + at + 46, nameLength));
    // ZIP64: the values that overflowed, in this fixed order.
    let x = at + 46 + nameLength;
    const extraEnd = x + extraLength;
    while (x + 4 <= extraEnd) {
      const id = dir.getUint16(x, true);
      const len = dir.getUint16(x + 2, true);
      if (id === 0x0001) {
        let p = x + 4;
        if (unpacked === MAX32) (unpacked = u64(dir, p)), (p += 8);
        if (packed === MAX32) (packed = u64(dir, p)), (p += 8);
        if (offset === MAX32) offset = u64(dir, p);
      }
      x += 4 + len;
    }
    at = extraEnd + commentLength;
    if (name.endsWith('/')) continue; // a folder

    const [entryPacked, entrySize, entryOffset] = [packed, unpacked, offset];
    const blob = async (): Promise<Blob> => {
      if (flags & 1) throw new ZipError(`“${name}” is encrypted`);
      if (method !== 0 && method !== 8) throw new ZipError(`“${name}” is compressed in a way this app cannot read`);
      const local = await view(file, entryOffset, entryOffset + 30);
      if (local.byteLength < 30 || local.getUint32(0, true) !== LOCAL) throw new ZipError(`The zip file is damaged (“${name}”)`);
      const dataAt = entryOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      const raw = file.slice(dataAt, dataAt + entryPacked);
      if (raw.size !== entryPacked) throw new ZipError(`The zip file is cut short (“${name}”)`);
      let data = raw;
      if (method === 8) {
        if (!canInflate) throw new ZipError('This browser cannot read compressed zip files; use a current browser');
        try {
          data = await through(raw, new DecompressionStream('deflate-raw'));
        } catch {
          throw new ZipError(`The zip file is damaged (“${name}” cannot be unpacked)`);
        }
      }
      if (data.size !== entrySize || (await crc32(data)) !== crc) throw new ZipError(`The zip file is damaged (“${name}” does not match its checksum)`);
      return data;
    };
    entries.push({ name, size: entrySize, blob, text: async () => (await blob()).text() });
  }
  return entries;
}
