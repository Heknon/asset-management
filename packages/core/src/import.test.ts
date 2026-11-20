import { describe, expect, it } from 'bun:test';
import { coerceCell, detectDateFormat, inferField, parseDate, parseNumber, parseTables, suggestMapping, type CoerceContext } from './import.js';
import type { FieldDefinition } from './fields.js';

const f = (key: string, label: string, kind: FieldDefinition['kind'], config: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), key, label, kind, required: false, restricted: false, showInTable: false, config }) as FieldDefinition;
const ctx: CoerceContext = { dateFormat: 'dmy', people: new Map([['dana@x.com', 'u1']]), assets: new Map([['HW-3', 'a3']]), options: new Map() };

describe('parsing tables', () => {
  it('reads CSV with quotes, commas and newlines inside cells', () => {
    const [t] = parseTables('﻿Name,Vendor,Notes\r\nFigma,"Figma, Inc.","two\nlines"\r\nMiro,Miro,"say ""hi"""\r\n');
    expect(t!.format).toBe('csv');
    expect(t!.headers).toEqual(['Name', 'Vendor', 'Notes']);
    expect(t!.rows).toEqual([['Figma', 'Figma, Inc.', 'two\nlines'], ['Miro', 'Miro', 'say "hi"']]);
  });

  it('sniffs semicolons and tabs (Excel exports and pastes)', () => {
    expect(parseTables('a;b\n1,5;2')[0]).toMatchObject({ format: 'semicolon', rows: [['1,5', '2']] });
    expect(parseTables('Name\tSeats\nFigma\t40')[0]).toMatchObject({ format: 'tsv', headers: ['Name', 'Seats'] });
  });

  it('finds every Markdown table with the heading above it', () => {
    const md = '# Licenses\n\nSome text\n\n| Name | Seats |\n|---|---:|\n| **Figma** | 40 |\n| [Miro](https://miro.com) | 10 |\n\n## SIMs\n| Number | Carrier |\n| --- | --- |\n| +1 555 | T-Mobile |\n';
    const tables = parseTables(md);
    expect(tables.map((t) => [t.name, t.rows.length])).toEqual([['Licenses', 2], ['SIMs', 1]]);
    expect(tables[0]!.rows[1]).toEqual(['Miro', '10']);
  });
});

describe('converting values', () => {
  it('reads dates the way people write them', () => {
    expect(parseDate('2026-01-31', 'dmy')).toBe('2026-01-31');
    expect(parseDate('31/01/2026', 'dmy')).toBe('2026-01-31');
    expect(parseDate('01/31/2026', 'mdy')).toBe('2026-01-31');
    expect(parseDate('31 Jan 2026', 'mdy')).toBe('2026-01-31');
    expect(parseDate('Jan 31, 2026', 'dmy')).toBe('2026-01-31');
    expect(parseDate('46053', 'dmy')).toBe('2026-01-31');
    expect(parseDate('31/02/2026', 'dmy')).toBeNull();
    expect(detectDateFormat(['03/04/2026', '25/12/2026'])).toEqual({ format: 'dmy', certain: true });
    expect(detectDateFormat(['03/04/2026'])).toEqual({ format: 'dmy', certain: false });
  });

  it('reads numbers with currency symbols and either decimal mark', () => {
    expect(parseNumber('$1,200.50')).toBe(1200.5);
    expect(parseNumber('1.200,50 €')).toBe(1200.5);
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('(300)')).toBe(-300);
    expect(parseNumber('n/a')).toBeNull();
  });

  it('maps cells to fields, with readable problems', () => {
    expect(coerceCell(f('renews', 'Renews', 'date'), '31/01/2026', ctx)).toEqual({ value: '2026-01-31' });
    expect(coerceCell(f('auto', 'Auto', 'boolean'), 'Yes', ctx)).toEqual({ value: true });
    expect(coerceCell(f('plan', 'Plan', 'select', { options: [{ value: 'business', label: 'Business' }] }), 'business', ctx)).toEqual({ value: 'business' });
    expect(coerceCell(f('plan', 'Plan', 'select', { options: [{ value: 'business', label: 'Business' }] }), 'Gold', ctx)).toEqual({ error: '“Gold” is not one of the options' });
    expect(coerceCell(f('who', 'Who', 'user'), 'dana@x.com', ctx)).toEqual({ value: 'u1' });
    expect(coerceCell(f('pcs', 'Machines', 'assetRef', { multiple: true }), 'HW-3; HW-9', ctx)).toEqual({ error: 'No item matches “HW-9”' });
    expect(coerceCell(f('macs', 'MACs', 'list'), 'AA:BB:CC:DD:EE:01, AA:BB:CC:DD:EE:02', ctx)).toEqual({ value: ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02'] });
    expect(coerceCell(f('x', 'X', 'text'), '   ', ctx)).toEqual({ empty: true });
  });
});

describe('matching columns', () => {
  const fields = [f('vendor', 'Vendor', 'text'), f('seats', 'Seats', 'number'), f('renewal_date', 'Renewal date', 'date'), f('cost_per_term', 'Cost per term', 'currency')];
  it('maps headers to fields and built-in targets, including common synonyms', () => {
    expect(suggestMapping(['Product', 'Supplier', '# of licenses', 'Expires', 'Annual cost', 'Department', 'Owner', 'Status', 'Notes'], [...fields, f('licenses', 'Licenses', 'number')])).toEqual([
      'name',
      'field:vendor',
      'field:licenses',
      'field:renewal_date',
      'field:cost_per_term',
      'unit',
      'owner',
      'status',
      'skip',
    ]);
  });

  it('guesses field kinds from a column', () => {
    const keys = new Set<string>();
    expect(inferField('Expires', ['31/01/2026', '15/03/2027'], keys).kind).toBe('date');
    expect(inferField('Annual cost', ['$1,200', '$300'], keys)).toMatchObject({ kind: 'currency', config: { currency: 'USD' } });
    expect(inferField('Seats', ['10', '40'], keys)).toMatchObject({ kind: 'number', config: { integer: true } });
    expect(inferField('Plan', ['Pro', 'Team', 'Pro', 'Team'], keys).kind).toBe('select');
    expect(inferField('MACs', ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02; AA:BB:CC:DD:EE:03'], keys).kind).toBe('list');
    expect(inferField('2nd contact', ['a@b.co'], keys)).toMatchObject({ kind: 'email', key: 'f_2nd_contact' });
  });
});
