import { describe, expect, it } from 'bun:test';
import { backupCsvLine, parseBackupCsv } from './backup.js';

describe('backup CSV', () => {
  const rows: (string | null)[][] = [
    ['id', 'name', 'note'],
    ['1', 'plain', null],
    ['2', '', ''],
    ['3', 'comma, "quote"', 'line\r\nbreak\n'],
    ['4', '=SUM(A1)', ' padded '],
    ['5', '{"a": [1, 2]}', '{x,"y z",NULL}'],
    [null, null, null],
  ];

  it('round-trips every value, keeping NULL apart from empty text', () => {
    const text = '﻿' + rows.map(backupCsvLine).join('');
    expect([...parseBackupCsv(text)]).toEqual(rows);
  });

  it('writes NULL as an empty cell and empty text as "", and leaves formulas alone', () => {
    expect(backupCsvLine(['a', null, '', '=1+1'])).toBe('a,,"",=1+1\r\n');
  });

  it('reads files without a final line break, with bare line feeds, and a single column', () => {
    expect([...parseBackupCsv('a,b\n1,\n"x",2')]).toEqual([['a', 'b'], ['1', null], ['x', '2']]);
    expect([...parseBackupCsv('id\r\n\r\n""\r\n')]).toEqual([['id'], [null], ['']]);
  });

  it('rejects malformed quoting', () => {
    expect(() => [...parseBackupCsv('a\r\n"open')]).toThrow(/not closed/);
    expect(() => [...parseBackupCsv('a\r\n"x"y\r\n')]).toThrow(/Unexpected/);
  });
});
