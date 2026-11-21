import type { AssetType } from './asset-type.js';
import type { Attributes } from './attributes.js';
import { isRestricted, type FieldDefinition } from './fields.js';

/**
 * Search is "type anything": every word must appear somewhere (prefix match,
 * any field), with typo-tolerant fuzzy matching as a fallback. Restricted
 * fields never enter the index.
 */

/** Lower-cases and strips accents, so "Café" and "cafe" match. Applied to both documents and queries. */
export function foldText(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Splits free text into normalised search terms (letters/digits, any script). */
export function searchTerms(q: string): string[] {
  return [
    ...new Set(
      foldText(q)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0),
    ),
  ].slice(0, 12);
}

/** Postgres tsquery for prefix matching of every term: `figm:* & enterpr:*`. */
export function prefixTsQuery(q: string): string | null {
  const terms = searchTerms(q);
  return terms.length ? terms.map((t) => `${t}:*`).join(' & ') : null;
}

export interface SearchLookups {
  typeName: string;
  statusLabel: string;
  unitName: string;
  personName: (id: string) => string | undefined;
  assetName?: (id: string) => string | undefined;
  /** "LIC-42" */
  reference?: string;
  /** Team variant name ("Design license"). */
  variantName?: string;
}

/** A value as people read it (option labels, names, "1200 USD"); shared by search text and CSV export. */
export function attributeText(field: FieldDefinition, value: unknown, l: Pick<SearchLookups, 'personName' | 'assetName'>): string | null {
  if (value === undefined || value === null || value === '') return null;
  switch (field.kind) {
    case 'select':
      return field.config.options.find((o) => o.value === value)?.label ?? String(value);
    case 'multiSelect':
      return (value as string[]).map((v) => field.config.options.find((o) => o.value === v)?.label ?? v).join(', ');
    case 'user':
      return l.personName(value as string) ?? null;
    case 'assetRef':
      return (Array.isArray(value) ? value : [value as string]).map((id) => l.assetName?.(id)).filter(Boolean).join(', ') || null;
    case 'list':
      return (value as string[]).join(', ');
    case 'boolean':
      return value ? 'yes' : 'no';
    case 'currency':
      return `${value} ${field.config.currency}`;
    case 'login': {
      // Never the password: search and CSV get the user name and the address.
      const v = value as { url?: string; username?: string };
      return [v.username, v.url].filter(Boolean).join(' · ') || null;
    }
    default:
      return String(value);
  }
}

/**
 * The searchable document of an asset: labelled segments so a match can be
 * shown in context ("Vendor: Figma · Seats: 40"). Never contains restricted values.
 */
export function buildSearchText(type: Pick<AssetType, 'fields'>, name: string, values: Attributes, ownerName: string | undefined, l: SearchLookups): string {
  const parts = [name, ...(l.reference ? [`ID: ${l.reference}`] : []), `Type: ${l.typeName}`, `Status: ${l.statusLabel}`, `Team: ${l.unitName}`];
  if (l.variantName) parts.push(`Kind: ${l.variantName}`);
  if (ownerName) parts.push(`Owner: ${ownerName}`);
  for (const f of type.fields) {
    if (isRestricted(f)) continue;
    const text = attributeText(f, values[f.key], l);
    if (text) parts.push(`${f.label}: ${text}`);
  }
  return parts.join(' · ').slice(0, 20_000);
}

/** Splits a «highlighted» snippet into plain and highlighted runs for safe rendering. */
export function highlightRuns(snippet: string): Array<{ text: string; hit: boolean }> {
  const runs: Array<{ text: string; hit: boolean }> = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) runs.push({ text: snippet.slice(last, m.index), hit: false });
    runs.push({ text: m[1]!, hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) runs.push({ text: snippet.slice(last), hit: false });
  return runs;
}

// ─── Organization import ─────────────────────────────────────────────────────

export interface OrgImportRow {
  line: number;
  path: string[];
  members: string[];
  managers: string[];
}

/**
 * Parses a pasted org chart, one unit per line:
 *   Wix / R&D / Editor
 *   Wix / R&D / Editor / Platform | CN=editor-platform,OU=Groups,DC=wix,DC=com ; department=Platform | CN=editor-leads,...
 * Columns: path | member directory ids (;-separated) | manager directory ids.
 * Blank lines and lines starting with # are ignored.
 */
export function parseOrgImport(text: string): { rows: OrgImportRow[]; errors: Array<{ line: number; message: string }> } {
  const rows: OrgImportRow[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const list = (s: string | undefined) => (s ?? '').split(';').map((x) => x.trim()).filter(Boolean);
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [pathPart, members, managers] = line.split('|');
    const path = (pathPart ?? '').split(/\s+[/>›]\s+|\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
    if (!path.length) return errors.push({ line: i + 1, message: 'Missing unit path' });
    if (path.some((p) => p.length > 120)) return errors.push({ line: i + 1, message: 'Unit names must be at most 120 characters' });
    rows.push({ line: i + 1, path, members: list(members), managers: list(managers) });
  });
  return { rows, errors };
}
