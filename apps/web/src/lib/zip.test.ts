import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipStreamWriter } from '@am/core';
import { crc32, readZip, ZipWriter } from './zip';

const python = (code: string, ...args: string[]) => {
  const r = Bun.spawnSync(['python3', '-c', code, ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};
const hasPython = Bun.which('python3') !== null;
const text = 'שלום, "world"\r\n'.repeat(500);
const bytes = new Blob([new Uint8Array(70_000).map((_, i) => (i * 31) % 251)]);

async function archive(zip64 = false) {
  const zip = new ZipWriter({ zip64 });
  await zip.add('manifest.json', '{"format":1}');
  await zip.add('registry/assets.csv', text);
  await zip.add('documents/assets/a/b', bytes);
  await zip.add('empty.csv', '');
  return zip.finish();
}

describe('zip', () => {
  it('computes CRC-32', async () => {
    expect(await crc32(new Blob(['123456789']))).toBe(0xcbf43926);
  });

  for (const zip64 of [false, true]) {
    const kind = zip64 ? 'ZIP64' : 'plain';

    it(`reads back what it wrote (${kind})`, async () => {
      const entries = await readZip(await archive(zip64));
      expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'registry/assets.csv', 'documents/assets/a/b', 'empty.csv']);
      expect(await entries[1]!.text()).toBe(text);
      expect(new Uint8Array(await (await entries[2]!.blob()).arrayBuffer())).toEqual(new Uint8Array(await bytes.arrayBuffer()));
      expect(await entries[3]!.text()).toBe('');
    });

    it.skipIf(!hasPython)(`writes archives other tools accept (${kind})`, async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'zip-')), 'a.zip');
      writeFileSync(path, new Uint8Array(await (await archive(zip64)).arrayBuffer()));
      const out = python(
        'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps([[i.filename,i.file_size,i.compress_type] for i in z.infolist()]))\nprint(z.read("registry/assets.csv").decode("utf-8")==sys.argv[2])',
        path,
        text,
      );
      const [list, same] = out.trim().split('\n');
      expect(JSON.parse(list!)).toEqual([
        ['manifest.json', 12, 0],
        ['registry/assets.csv', new Blob([text]).size, 8],
        ['documents/assets/a/b', 70_000, 0],
        ['empty.csv', 0, 0],
      ]);
      expect(same).toBe('True');
    });
  }

  it.skipIf(!hasPython)('reads archives made by other tools, deflated and with a comment', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'zip-')), 'b.zip');
    python(
      'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nz.writestr("backup/manifest.json","{}")\nz.writestr("backup/registry/assets.csv",sys.argv[2])\nz.comment=b"hello"\nz.close()',
      path,
      text,
    );
    const entries = await readZip(Bun.file(path));
    expect(entries.map((e) => e.name)).toEqual(['backup/manifest.json', 'backup/registry/assets.csv']);
    expect(await entries[1]!.text()).toBe(text);
  });

  it('refuses files that are not zips, and notices damage', async () => {
    await expect(readZip(new Blob(['id,name\r\n1,x\r\n'.repeat(10)]))).rejects.toThrow('Not a zip file');
    const good = new Uint8Array(await (await archive()).arrayBuffer());
    // Flip a byte inside the compressed CSV.
    const at = 30 + 'manifest.json'.length + 12 + 30 + 'registry/assets.csv'.length + 20;
    good[at] = good[at]! ^ 0xff;
    const entries = await readZip(new Blob([good]));
    await expect(entries[1]!.text()).rejects.toThrow(/damaged/);
    expect(await entries[0]!.text()).toBe('{"format":1}');
  });

  it('reads archives the services stream into storage', async () => {
    const parts: Uint8Array[] = [];
    const zip = new ZipStreamWriter(async (b) => void parts.push(b));
    const entry = await zip.entry('registry/assets.csv');
    for (let i = 0; i < 500; i++) await entry.write('שלום, "world"\r\n');
    await entry.close();
    await zip.add('empty.csv', '');
    await zip.add('manifest.json', '{"format":1}');
    await zip.finish();
    const entries = await readZip(new Blob(parts as BlobPart[]));
    expect(entries.map((e) => [e.name, e.size])).toEqual([['registry/assets.csv', new Blob([text]).size], ['empty.csv', 0], ['manifest.json', 12]]);
    expect(await entries[0]!.text()).toBe(text);
    expect(await entries[1]!.text()).toBe('');
    expect(await entries[2]!.text()).toBe('{"format":1}');
  });
});
