/**
 * Writes a zip as a stream: entries are compressed as their bytes arrive and
 * nothing is held in memory, so a service can build a large archive straight
 * into storage. Uses the platform's own compression stream (Node, Bun and
 * browsers have it). Archives stay under the classic 4 GB limits.
 */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Running CRC-32: start with 0xffffffff, feed bytes, finish with `(crc ^ 0xffffffff) >>> 0`. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

const MAX32 = 0xffffffff;
/** UTF-8 names, and sizes written after the data (they are not known before). */
const FLAGS = 0x0800 | 0x0008;

function record(size: number, fill: (v: DataView) => void, ...tail: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(size + tail.reduce((n, t) => n + t.length, 0));
  fill(new DataView(out.buffer));
  let at = size;
  for (const t of tail) {
    out.set(t, at);
    at += t.length;
  }
  return out;
}

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  packed: number;
  offset: number;
}

export interface ZipEntryWriter {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

export class ZipStreamWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private open = false;
  private readonly time: number;
  private readonly date: number;

  /** `sink` receives the archive's bytes in order. */
  constructor(
    private readonly sink: (bytes: Uint8Array) => Promise<void>,
    at = new Date(),
  ) {
    this.time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
    this.date = ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  }

  private async emit(bytes: Uint8Array) {
    this.offset += bytes.length;
    if (this.offset > MAX32) throw new Error('The archive is larger than 4 GB');
    await this.sink(bytes);
  }

  /** Starts a file; write its contents, then close it before starting the next. */
  async entry(name: string): Promise<ZipEntryWriter> {
    if (this.open) throw new Error('The previous entry is still open');
    this.open = true;
    const entry: Entry = { name: new TextEncoder().encode(name), crc: MAX32, size: 0, packed: 0, offset: this.offset };
    await this.emit(
      record(
        30,
        (v) => {
          v.setUint32(0, 0x04034b50, true);
          v.setUint16(4, 20, true);
          v.setUint16(6, FLAGS, true);
          v.setUint16(8, 8, true);
          v.setUint16(10, this.time, true);
          v.setUint16(12, this.date, true);
          v.setUint16(26, entry.name.length, true);
        },
        entry.name,
      ),
    );

    const deflate = new CompressionStream('deflate-raw');
    const input = deflate.writable.getWriter();
    const reader = deflate.readable.getReader();
    const output = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        entry.packed += value.length;
        await this.emit(value);
      }
    })();
    // A failure while writing out surfaces on close; this keeps it from being reported as unhandled first.
    output.catch(() => undefined);
    const encoder = new TextEncoder();

    return {
      write: async (data) => {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data;
        entry.crc = crc32Update(entry.crc, bytes);
        entry.size += bytes.length;
        await input.write(bytes as Uint8Array<ArrayBuffer>);
      },
      close: async () => {
        await input.close();
        await output;
        entry.crc = (entry.crc ^ MAX32) >>> 0;
        if (entry.size > MAX32) throw new Error('A file in the archive is larger than 4 GB');
        await this.emit(
          record(16, (v) => {
            v.setUint32(0, 0x08074b50, true);
            v.setUint32(4, entry.crc, true);
            v.setUint32(8, entry.packed, true);
            v.setUint32(12, entry.size, true);
          }),
        );
        this.entries.push(entry);
        this.open = false;
      },
    };
  }

  /** A whole small file at once. */
  async add(name: string, data: Uint8Array | string): Promise<void> {
    const e = await this.entry(name);
    await e.write(data);
    await e.close();
  }

  /** Writes the directory; the archive is complete after this. */
  async finish(): Promise<void> {
    if (this.open) throw new Error('An entry is still open');
    if (this.entries.length > 0xfffe) throw new Error('Too many files for one archive');
    const start = this.offset;
    for (const e of this.entries) {
      await this.emit(
        record(
          46,
          (v) => {
            v.setUint32(0, 0x02014b50, true);
            v.setUint16(4, 20, true);
            v.setUint16(6, 20, true);
            v.setUint16(8, FLAGS, true);
            v.setUint16(10, 8, true);
            v.setUint16(12, this.time, true);
            v.setUint16(14, this.date, true);
            v.setUint32(16, e.crc, true);
            v.setUint32(20, e.packed, true);
            v.setUint32(24, e.size, true);
            v.setUint16(28, e.name.length, true);
            v.setUint32(42, e.offset, true);
          },
          e.name,
        ),
      );
    }
    const size = this.offset - start;
    await this.emit(
      record(22, (v) => {
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, this.entries.length, true);
        v.setUint16(10, this.entries.length, true);
        v.setUint32(12, size, true);
        v.setUint32(16, start, true);
      }),
    );
  }
}
