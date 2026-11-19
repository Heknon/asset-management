import { AppError, foldText, isRestricted, isValidIsoDate, prefixTsQuery, searchTerms, type AssetFilter, type FieldDefinition } from '@am/core';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

/** SQL building blocks for search and field filters, shared by assets and requests. */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export interface TextSearch {
  where: RawBuilder<SqlBool>;
  rank: RawBuilder<number>;
  snippet: RawBuilder<string>;
}

/**
 * "Type anything" matching on a table with `search_text` (display),
 * `search_key` (folded) and `search_vector` columns. Every word must match,
 * and each word may match in any of three ways:
 *   - as the start of a word   (full-text prefix: "plat" → Platform)
 *   - anywhere inside the text (substring: serials, codes, "1ABMD")
 *   - approximately            (pg_trgm word similarity: "githb" → GitHub)
 * so "githb plat" finds "GitHub Enterprise — Platform".
 */
export function textSearch(table: string, q: string, fuzzy: boolean): TextSearch | null {
  const terms = searchTerms(q);
  if (!terms.length) return null;
  const col = (c: string) => sql.ref(`${table}.${c}`);
  const termMatch = (t: string) => {
    const ways: Array<RawBuilder<SqlBool>> = [sql<SqlBool>`${col('search_vector')} @@ to_tsquery('simple', ${`${t}:*`})`];
    if (t.length >= 3) ways.push(sql<SqlBool>`${col('search_key')} like ${`%${escapeLike(t)}%`}`);
    if (fuzzy && t.length >= 4) ways.push(sql<SqlBool>`${t} <% ${col('search_key')}`);
    return sql<SqlBool>`(${sql.join(ways, sql` or `)})`;
  };
  const anyPrefix = sql`to_tsquery('simple', ${prefixTsQuery(q)!.replaceAll(' & ', ' | ')})`;
  const folded = foldText(q).trim();
  return {
    where: sql<SqlBool>`(${sql.join(terms.map(termMatch), sql` and `)})`,
    rank: sql<number>`(
      ts_rank(${col('search_vector')}, ${anyPrefix})
      + case when lower(${col('search_text')}) like ${`${escapeLike(folded)}%`} then 1 else 0 end
      ${fuzzy ? sql`+ ${sql.join(terms.map((t) => sql`word_similarity(${t}, ${col('search_key')})`), sql` + `)}` : sql``}
    )`,
    snippet: sql<string>`ts_headline('simple', ${col('search_text')}, ${anyPrefix}, 'StartSel=«, StopSel=», MaxWords=18, MinWords=6, MaxFragments=2, FragmentDelimiter=" … "')`,
  };
}

const SYSTEM: Record<string, { column: string; kind: 'text' | 'id' | 'timestamp' }> = {
  name: { column: 'assets.name', kind: 'text' },
  status: { column: 'assets.status', kind: 'id' },
  ownerId: { column: 'assets.owner_id', kind: 'id' },
  assetTypeId: { column: 'assets.asset_type_id', kind: 'id' },
  createdAt: { column: 'assets.created_at', kind: 'timestamp' },
  updatedAt: { column: 'assets.updated_at', kind: 'timestamp' },
};

type ValueKind = 'text' | 'number' | 'date' | 'boolean' | 'id' | 'list';

function kindOfField(f: FieldDefinition | undefined, value: unknown): ValueKind {
  if (!f) return typeof value === 'number' ? 'number' : isValidIsoDate(value) ? 'date' : 'text';
  switch (f.kind) {
    case 'number':
    case 'currency':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    case 'select':
    case 'user':
    case 'assetRef':
      return 'id';
    case 'multiSelect':
      return 'list';
    default:
      return 'text';
  }
}

const bad = (f: AssetFilter, msg: string) => AppError.validation(`Filter on "${f.field}": ${msg}`);

function scalar(f: AssetFilter, kind: ValueKind, v: unknown): unknown {
  if (kind === 'number') {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(f, 'expects a number');
    return n;
  }
  if (kind === 'date') {
    if (!isValidIsoDate(v)) throw bad(f, 'expects a date (YYYY-MM-DD)');
    return v;
  }
  if (kind === 'boolean') {
    if (typeof v !== 'boolean') throw bad(f, 'expects yes or no');
    return v;
  }
  if (typeof v !== 'string' || !v.length) throw bad(f, 'expects a value');
  return v;
}

/**
 * One filter → SQL. Attribute fields are typed by the asset type when known,
 * so "Seats more than 10" compares numbers and "Renewal before 2027-01-01"
 * compares dates. Restricted fields cannot be filtered on.
 */
export function filterExpression(f: AssetFilter, type: { fields: FieldDefinition[] } | null): RawBuilder<SqlBool> {
  let expr: RawBuilder<unknown>;
  let kind: ValueKind;
  let raw: RawBuilder<unknown> | null = null;

  if (f.field.startsWith('attributes.')) {
    const key = f.field.slice('attributes.'.length);
    const field = type?.fields.find((x) => x.key === key);
    if (type && !field) throw bad(f, 'unknown field');
    if (field && isRestricted(field)) throw bad(f, 'restricted fields cannot be searched');
    kind = kindOfField(field, Array.isArray(f.value) ? f.value[0] : f.value);
    raw = sql`assets.attributes -> ${key}`;
    expr =
      kind === 'number'
        ? sql`(case when jsonb_typeof(assets.attributes -> ${key}) = 'number' then (assets.attributes ->> ${key})::numeric end)`
        : sql`(assets.attributes ->> ${key})`;
  } else {
    const sys = SYSTEM[f.field]!;
    kind = sys.kind === 'timestamp' ? 'date' : sys.kind;
    expr = sys.kind === 'timestamp' ? sql`(${sql.ref(sys.column)})::date::text` : sql.ref(sys.column);
  }

  const v = f.value;
  switch (f.op) {
    case 'isEmpty':
      return raw ? sql<SqlBool>`(${raw} is null or ${raw} = 'null'::jsonb or ${raw} = '""'::jsonb or ${raw} = '[]'::jsonb)` : sql<SqlBool>`${expr} is null`;
    case 'isNotEmpty':
      return raw ? sql<SqlBool>`not (${raw} is null or ${raw} = 'null'::jsonb or ${raw} = '""'::jsonb or ${raw} = '[]'::jsonb)` : sql<SqlBool>`${expr} is not null`;
    case 'contains':
      if (kind === 'list') return sql<SqlBool>`coalesce(${raw} ? ${scalar(f, 'id', v)}, false)`;
      return sql<SqlBool>`${expr}::text ilike ${`%${escapeLike(String(scalar(f, 'text', v)))}%`}`;
    case 'equals':
    case 'notEquals': {
      let cond: RawBuilder<SqlBool>;
      if (kind === 'boolean') cond = sql<SqlBool>`${raw} = to_jsonb(${scalar(f, 'boolean', v)}::boolean)`;
      else if (kind === 'list') cond = sql<SqlBool>`coalesce(${raw} ? ${scalar(f, 'id', v)}, false)`;
      else if (kind === 'text') cond = sql<SqlBool>`lower(${expr}::text) = lower(${scalar(f, 'text', v)})`;
      else cond = sql<SqlBool>`${expr} = ${scalar(f, kind, v)}`;
      return f.op === 'equals' ? cond : sql<SqlBool>`not coalesce(${cond}, false)`;
    }
    case 'in': {
      if (!Array.isArray(v) || !v.length || v.length > 200) throw bad(f, 'expects a list of values');
      const values = v.map((x) => String(scalar(f, kind === 'list' ? 'id' : kind === 'number' ? 'number' : 'id', x)));
      if (kind === 'list') return sql<SqlBool>`coalesce(${raw} ?| ${sql.val(values)}::text[], false)`;
      return sql<SqlBool>`${expr}::text = any(${sql.val(values)}::text[])`;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (kind !== 'number' && kind !== 'date') throw bad(f, 'can only compare numbers and dates');
      const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
      return sql<SqlBool>`${expr} ${sql.raw(op)} ${scalar(f, kind, v)}`;
    }
    case 'between': {
      if (kind !== 'number' && kind !== 'date') throw bad(f, 'can only compare numbers and dates');
      if (!Array.isArray(v) || v.length !== 2) throw bad(f, 'expects a from and a to value');
      return sql<SqlBool>`${expr} between ${scalar(f, kind, v[0])} and ${scalar(f, kind, v[1])}`;
    }
  }
}
