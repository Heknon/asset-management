import { bestShareLevel, type AccessLevel, type Scope, type Visibility } from '@am/core';
import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';

/**
 * Turns permission scopes into a WHERE expression for any table. Grants apply
 * to a unit's whole subtree, so a scope matches when its unit appears in the
 * row's unit ancestor path (a uuid[] column, root first, including the unit):
 *   (A = ANY(path) AND type = T) OR (B = ANY(path)) OR ...
 * No scopes ⇒ matches nothing.
 */
export function scopeFilter(scopes: readonly Scope[], unitPathColumn: string, assetTypeColumn: string): RawBuilder<SqlBool> {
  if (!scopes.length) return sql<SqlBool>`false`;
  if (scopes.some((s) => s.unitId === null && s.assetTypeId === null)) return sql<SqlBool>`true`;
  const clauses = scopes.map((s) => {
    const parts = [
      ...(s.unitId ? [sql`${s.unitId}::uuid = any(${sql.ref(unitPathColumn)})`] : []),
      ...(s.assetTypeId ? [sql`${sql.ref(assetTypeColumn)} = ${s.assetTypeId}::uuid`] : []),
    ];
    return sql`(${sql.join(parts, sql` and `)})`;
  });
  return sql<SqlBool>`(${sql.join(clauses, sql` or `)})`;
}

/** Rows whose unit is `unitId` or beneath it. */
export function inSubtree(unitId: string, unitPathColumn: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`${unitId}::uuid = any(${sql.ref(unitPathColumn)})`;
}

/**
 * Rows the caller may see (or change) at a level: org-tree scopes, OR the
 * row's catalog is shared with one of the caller's share keys at a level that
 * suffices. Every service that holds catalog shares keeps them in a table
 * named `catalog_shares (catalog_id, subject_key, level)`.
 */
export function visibleFilter(v: Visibility, cols: { unitPath: string; assetType: string; catalog: string }): RawBuilder<SqlBool> {
  const tree = scopeFilter(v.scopes, cols.unitPath, cols.assetType);
  if (!v.shareKeys.length || !v.shareLevels.length) return tree;
  const shared = sql<SqlBool>`${sql.ref(cols.catalog)} in (select s.catalog_id from catalog_shares s where s.subject_key = any(${sql.val(v.shareKeys)}::text[]) and s.level = any(${sql.val(v.shareLevels)}::text[]))`;
  return sql<SqlBool>`(${tree} or ${shared})`;
}

/** The best level the caller's share keys have on a catalog (any service's `catalog_shares`). */
export async function catalogShareLevel(db: Kysely<any>, catalogId: string | null, shareKeys: readonly string[]): Promise<AccessLevel> {
  if (!catalogId || !shareKeys.length) return 'none';
  const { rows } = await sql<{ level: string }>`select level from catalog_shares where catalog_id = ${catalogId}::uuid and subject_key = any(${sql.val([...shareKeys])}::text[])`.execute(db);
  return bestShareLevel(rows.map((r) => r.level));
}
