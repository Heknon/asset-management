/**
 * Importing tables people already have: CSV / TSV / semicolon files, tables
 * pasted from Excel or Google Sheets, and Markdown tables (one or many per
 * file). Parsing, column matching and value conversion are pure, so the
 * browser can preview instantly and the server applies the same rules.
 */
import { z } from 'zod';
import type { AssetType } from './asset-type.js';
import { isValidIsoDate, type IsoDate } from './duration.js';
import { fieldKeySchema, type FieldDefinition } from './fields.js';
import { foldText } from './search.js';

export interface ParsedTable {
  /** The heading above a Markdown table, or "Table 2". */
  name: string;
  format: 'csv' | 'tsv' | 'semicolon' | 'pipe' | 'markdown';
  headers: string[];
  rows: string[][];
}

const MD_ROW = /^\s*\|.*\|\s*$/;
const MD_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitMarkdownRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  // Light Markdown clean-up: **bold**, `code`, [text](url) → text.
  return cells.map((x) => x.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<br\s*\/?>/gi, '\n'));
}

function parseMarkdown(text: string): ParsedTable[] {
  const lines = text.split(/\r?\n/);
  const tables: ParsedTable[] = [];
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) heading = h[1]!;
    if (!MD_ROW.test(line) || !MD_SEPARATOR.test(lines[i + 1] ?? '')) continue;
    const headers = splitMarkdownRow(line);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && MD_ROW.test(lines[j]!); j++) rows.push(splitMarkdownRow(lines[j]!));
    tables.push({ name: heading || `Table ${tables.length + 1}`, format: 'markdown', headers, rows });
    i = j - 1;
  }
  return tables;
}

/** RFC 4180 with any delimiter; quoted cells may contain delimiters, quotes ("") and newlines. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

/** The delimiter that splits the first lines into the same, largest number of columns. */
function sniffDelimiter(text: string): ',' | ';' | '\t' | '|' {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best: { d: ',' | ';' | '\t' | '|'; score: number } = { d: ',', score: -1 };
  for (const d of ['\t', ',', ';', '|'] as const) {
    const counts = sample.map((l) => parseDelimited(l, d)[0]?.length ?? 0);
    const cols = Math.max(...counts);
    if (cols < 2) continue;
    const consistent = counts.filter((n) => n === cols).length / counts.length;
    const score = consistent * 10 + Math.min(cols, 50) / 50;
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

/** Every table in a file or paste. Markdown tables win when present. */
export function parseTables(raw: string): ParsedTable[] {
  const text = raw.replace(/^﻿/, '');
  const md = parseMarkdown(text);
  if (md.length) return md;
  const d = sniffDelimiter(text);
  const rows = parseDelimited(text, d);
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const [headers, ...body] = rows.map(pad);
  return [{ name: 'Table 1', format: d === '\t' ? 'tsv' : d === ';' ? 'semicolon' : d === '|' ? 'pipe' : 'csv', headers: headers!.map((h, i) => h || `Column ${i + 1}`), rows: body }];
}

// ─── Matching columns to fields ──────────────────────────────────────────────

/** Built-in targets every import can map to, besides template fields. */
export const importTargets = ['name', 'reference', 'owner', 'unit', 'status'] as const;
export type ImportTarget = (typeof importTargets)[number] | `field:${string}` | 'skip';

/** Folded, punctuation-free, without filler ("# of licenses" → "licenses"). */
const norm = (s: string) =>
  foldText(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(number of|num of|no of|nr of|count of|of|total)\s+/, '');

const targetWords: Record<(typeof importTargets)[number], string[]> = {
  name: ['name', 'title', 'item', 'product', 'asset', 'software', 'service', 'license name', 'item name'],
  reference: ['id', 'ref', 'reference', 'asset id', 'item id'],
  owner: ['owner', 'responsible', 'business owner', 'owned by', 'contact'],
  unit: ['team', 'department', 'dept', 'unit', 'division', 'group', 'cost center', 'org unit'],
  status: ['status', 'state'],
};

/** Words people use for the same thing in spreadsheets; two names match when they are in the same group. */
const synonyms: string[][] = [
  ['renewal', 'renewal date', 'renews', 'renew', 'next renewal', 'expires', 'expires on', 'expiry', 'expiry date', 'expiration', 'expiration date', 'end date', 'valid until', 'contract end'],
  ['cost', 'price', 'amount', 'annual cost', 'yearly cost', 'cost per year', 'cost per term', 'fee', 'spend', 'monthly cost'],
  ['vendor', 'supplier', 'provider', 'manufacturer', 'publisher', 'registrar', 'carrier'],
  ['seats', 'licenses', 'licences', 'quantity', 'qty', 'users', 'seat count'],
  ['serial', 'serial number', 's n', 'sn'],
  ['assignee', 'assigned to', 'employee', 'holder', 'user name'],
  ['purchase order', 'po', 'po number', 'order number'],
  ['purchase date', 'bought', 'bought on', 'date of purchase', 'order date'],
  ['mac addresses', 'macs', 'mac', 'workstation macs', 'mac address'],
];
const groupOf = (t: string) => synonyms.findIndex((g) => g.includes(t));

function similarity(header: string, candidates: string[]): number {
  const h = norm(header);
  const hg = groupOf(h);
  let best = 0;
  for (const raw of candidates) {
    const c = norm(raw);
    if (!c) continue;
    if (h === c) best = Math.max(best, 1);
    else if (hg >= 0 && hg === groupOf(c)) best = Math.max(best, 0.75);
    else if (h.split(' ').includes(c) || c.split(' ').includes(h)) best = Math.max(best, 0.7);
    else if (c.length >= 4 && h.length >= 4 && (h.includes(c) || c.includes(h))) best = Math.max(best, 0.6);
  }
  return best;
}

/** Best target per column (each used once, strongest first), with how sure the match is. */
function matchColumns(headers: string[], fields: readonly FieldDefinition[]): Array<{ target: ImportTarget; score: number }> {
  const options: Array<{ col: number; target: ImportTarget; score: number }> = [];
  headers.forEach((h, col) => {
    for (const t of importTargets) options.push({ col, target: t, score: similarity(h, targetWords[t]) - (t === 'name' ? 0.05 : 0) });
    for (const f of fields) options.push({ col, target: `field:${f.key}`, score: similarity(h, [f.label, f.key.replace(/_/g, ' ')]) });
  });
  const out: Array<{ target: ImportTarget; score: number }> = headers.map(() => ({ target: 'skip', score: 0 }));
  const used = new Set<string>();
  for (const o of options.filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score)) {
    if (out[o.col]!.target !== 'skip' || used.has(o.target)) continue;
    out[o.col] = { target: o.target, score: o.score };
    used.add(o.target);
  }
  // Without a recognisable name column, the first unmatched column names the items.
  if (!used.has('name')) {
    const first = out.findIndex((t) => t.target === 'skip');
    if (first >= 0) out[first] = { target: 'name', score: 0.5 };
  }
  return out;
}

export function suggestMapping(headers: string[], fields: readonly FieldDefinition[]): ImportTarget[] {
  return matchColumns(headers, fields).map((m) => m.target);
}

/** How well a template fits a table: the strength of its field matches (exact names beat synonyms). */
export function templateFit(headers: string[], type: Pick<AssetType, 'fields'>): number {
  return matchColumns(headers, type.fields)
    .filter((m) => m.target.startsWith('field:'))
    .reduce((n, m) => n + m.score, 0);
}

// ─── Converting cells ────────────────────────────────────────────────────────

export type DateFormat = 'iso' | 'dmy' | 'mdy';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

function toIso(y: number, m: number, d: number): IsoDate | null {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  const iso = `${y}-${pad2(m)}-${pad2(d)}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** Dates as people write them: 2026-01-31, 31/01/2026, 01/31/2026, 31 Jan 2026, Jan 31, 2026, Excel serials. */
export function parseDate(raw: string, format: DateFormat): IsoDate | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return toIso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) return format === 'mdy' ? toIso(+m[3]!, +m[1]!, +m[2]!) : toIso(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s-,]+(\d{2,4})$/.exec(s);
  if (m && MONTHS.includes(m[2]!.slice(0, 3).toLowerCase())) return toIso(+m[3]!, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, +m[1]!);
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(s);
  if (m && MONTHS.includes(m[1]!.slice(0, 3).toLowerCase())) return toIso(+m[3]!, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, +m[2]!);
  // Excel serial day numbers (1900 system), as exported from some sheets.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

/** For a column of dates: day-first when any first part is > 12, month-first when any second part is. */
export function detectDateFormat(samples: string[]): { format: DateFormat; certain: boolean } {
  let dayFirst = false;
  let monthFirst = false;
  let slashed = false;
  for (const s of samples) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s.trim());
    if (!m) continue;
    slashed = true;
    if (+m[1]! > 12) dayFirst = true;
    if (+m[2]! > 12) monthFirst = true;
  }
  if (!slashed) return { format: 'iso', certain: true };
  if (dayFirst !== monthFirst) return { format: dayFirst ? 'dmy' : 'mdy', certain: true };
  return { format: 'dmy', certain: false };
}

/** "$1,200.50", "1.200,50 €", "1 200", "(300)" → number. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/[\s ']/g, '').replace(/^[^\d\-(.,]+|[^\d).,]+$/g, '');
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // "1.234,56" or "1234,56": comma is the decimal point unless it groups thousands ("1,234").
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

const TRUE = ['yes', 'y', 'true', '1', 'x', '✓', '✔', 'on', 'כן'];
const FALSE = ['no', 'n', 'false', '0', '', '-', 'off', 'לא'];
const splitList = (s: string) => s.split(/\s*[\n;|,]\s*/).map((x) => x.trim()).filter(Boolean);

export interface CoerceContext {
  dateFormat: DateFormat;
  /** Resolved people for "user" fields, by the cell text (email, username or name). */
  people: ReadonlyMap<string, string | null>;
  /** Resolved items for "linked asset" fields, by the cell text (ID or name). */
  assets: ReadonlyMap<string, string | null>;
  /** Per select field: cell text → option value (or null: leave empty). */
  options: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
}

export type Coerced = { value: unknown } | { empty: true } | { error: string };

/** One cell → a value the field accepts (validated again by the server). */
export function coerceCell(field: FieldDefinition, raw: string, ctx: CoerceContext): Coerced {
  const s = raw.trim();
  if (!s) return { empty: true };
  const option = (v: string) => {
    if (field.kind !== 'select' && field.kind !== 'multiSelect') return undefined;
    const mapped = ctx.options.get(field.key)?.get(v);
    if (mapped !== undefined) return mapped;
    return field.config.options.find((o) => foldText(o.label) === foldText(v) || o.value === foldText(v).replace(/\W+/g, '_'))?.value;
  };
  switch (field.kind) {
    case 'number':
    case 'currency': {
      const n = parseNumber(s);
      return n === null ? { error: `“${s}” is not a number` } : { value: n };
    }
    case 'date': {
      const d = parseDate(s, ctx.dateFormat);
      return d ? { value: d } : { error: `“${s}” is not a date` };
    }
    case 'boolean': {
      const v = foldText(s);
      if (TRUE.includes(v)) return { value: true };
      if (FALSE.includes(v)) return { value: false };
      return { error: `“${s}” is not yes/no` };
    }
    case 'select': {
      const v = option(s);
      return v === null ? { empty: true } : v === undefined ? { error: `“${s}” is not one of the options` } : { value: v };
    }
    case 'multiSelect': {
      const values = splitList(s).map((x) => ({ x, v: option(x) }));
      const bad = values.filter((x) => x.v === undefined);
      if (bad.length) return { error: `Not options: ${bad.map((b) => b.x).join(', ')}` };
      const ok = values.map((x) => x.v).filter((v): v is string => !!v);
      return ok.length ? { value: ok } : { empty: true };
    }
    case 'user': {
      const id = ctx.people.get(s);
      return id ? { value: id } : { error: `No person matches “${s}”` };
    }
    case 'assetRef': {
      const parts = field.config.multiple ? splitList(s) : [s];
      const ids = parts.map((p) => ({ p, id: ctx.assets.get(p) }));
      const bad = ids.filter((x) => !x.id);
      if (bad.length) return { error: `No item matches ${bad.map((b) => `“${b.p}”`).join(', ')}` };
      return { value: field.config.multiple ? ids.map((x) => x.id) : ids[0]!.id };
    }
    case 'list':
      return { value: splitList(s) };
    case 'email':
      return { value: s.toLowerCase() };
    case 'url':
      return { value: /^[a-z]+:\/\//i.test(s) ? s : `https://${s}` };
    default:
      return { value: s };
  }
}

// ─── Templates and fields from columns ───────────────────────────────────────

const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** A field definition guessed from a column's header and values (for "new template / team fields from these columns"). */
export function inferField(header: string, samples: string[], existingKeys: ReadonlySet<string>): FieldDefinition {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  const label = header.trim().slice(0, 80) || 'Column';
  let key = foldText(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 60) || 'field';
  if (!fieldKeySchema.safeParse(key).success) key = 'field';
  for (let i = 2; existingKeys.has(key); i++) key = `${key.replace(/_\d+$/, '')}_${i}`;
  const base = { id: globalThis.crypto.randomUUID(), key, label, required: false, restricted: false, showInTable: false };
  const all = (re: RegExp | ((v: string) => boolean)) => values.length > 0 && values.every((v) => (typeof re === 'function' ? re(v) : re.test(v)));
  const h = norm(header);
  if (all((v) => splitList(v).every((x) => MAC.test(x)))) return { ...base, kind: 'list', config: { pattern: MAC.source, maxItems: 200 } };
  if (all((v) => parseDate(v, detectDateFormat(values).format) !== null) && !all(/^\d+$/)) return { ...base, kind: 'date', config: {} };
  if (all((v) => parseNumber(v) !== null)) {
    const money = /cost|price|amount|fee|spend|budget|total|value/.test(h) || values.some((v) => /[$€£₪¥]/.test(v));
    return money ? { ...base, kind: 'currency', config: { currency: values.some((v) => v.includes('€')) ? 'EUR' : values.some((v) => v.includes('£')) ? 'GBP' : values.some((v) => v.includes('₪')) ? 'ILS' : 'USD', countsTowardSpend: false } } : { ...base, kind: 'number', config: { integer: values.every((v) => Number.isInteger(parseNumber(v))) } };
  }
  if (all((v) => [...TRUE, ...FALSE].includes(foldText(v)))) return { ...base, kind: 'boolean', config: {} };
  if (all(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return { ...base, kind: 'email', config: {} };
  if (all(/^https?:\/\//i)) return { ...base, kind: 'url', config: {} };
  const distinct = [...new Set(values)];
  if (values.length >= 4 && distinct.length <= Math.min(12, Math.ceil(values.length / 2)) && distinct.every((v) => v.length <= 40)) {
    return { ...base, kind: 'select', config: { options: distinct.map((v, i) => ({ value: foldText(v).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'o_$1') || `option_${i + 1}`, label: v })) } };
  }
  if (values.some((v) => v.length > 120 || v.includes('\n'))) return { ...base, kind: 'longText', config: {} };
  return { ...base, kind: 'text', config: {} };
}

// ─── API ─────────────────────────────────────────────────────────────────────

const uuid = z.string().uuid();

export const importRowSchema = z.object({
  /** Row number in the file (for messages). */
  line: z.number().int().positive(),
  name: z.string().trim().max(200),
  unitId: uuid.nullable(),
  ownerId: uuid.nullable().optional(),
  status: z.string().max(60).optional(),
  /** For matching existing items ("LIC-42"). */
  reference: z.string().max(40).optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  /** Conversion problems found in the browser (shown with the server's). */
  issues: z.record(z.string(), z.string()).default({}),
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importRequestSchema = z.object({
  assetTypeId: uuid,
  variantId: uuid.nullable().default(null),
  catalogId: uuid.nullable().default(null),
  /** "create": every row is a new item. "upsert": rows matching an existing item update it. */
  mode: z.enum(['create', 'upsert']).default('create'),
  /** How rows find existing items: their ID, their name (within the team), or a field (e.g. a serial number). */
  matchBy: z.union([z.literal('reference'), z.literal('name'), z.string().regex(/^field:[a-z][a-z0-9_]*$/)]).default('name'),
  dryRun: z.boolean().default(true),
  /** Further chunks of the same import reuse its id. */
  batchId: uuid.optional(),
  fileName: z.string().max(200).default('pasted table'),
  rows: z.array(importRowSchema).min(1).max(500),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export interface ImportRowResult {
  line: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  assetId?: string;
  reference?: string;
  /** Field key (or "row") → message. */
  errors?: Record<string, string>;
}

export interface ImportResult {
  batchId: string | null;
  rows: ImportRowResult[];
  counts: { create: number; update: number; unchanged: number; error: number };
}

export interface ImportBatch {
  id: string;
  assetTypeId: string;
  fileName: string;
  createdByName: string;
  created: number;
  updated: number;
  createdAt: string;
  undoneAt: string | null;
  /** Items still unchanged since the import (what "Undo" would remove). */
  undoable: number;
}

export const peopleResolveSchema = z.object({ values: z.array(z.string().trim().min(1).max(200)).max(2000) });
