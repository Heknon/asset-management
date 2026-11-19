import { unionPermissions, type Permission, type Scope, type Visibility } from '@am/core';
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
 * Rows the caller may see (or act on): org-tree scopes for the permission, OR
 * the row's catalog is shared with one of the caller's subject keys with that
 * permission. Every service that holds catalog shares keeps them in a table
 * named `catalog_shares (catalog_id, subject_key, permissions text[])`.
 */
export function visibleFilter(v: Visibility, cols: { unitPath: string; assetType: string; catalog: string; owner: string }): RawBuilder<SqlBool> {
  const parts = [scopeFilter(v.scopes, cols.unitPath, cols.assetType)];
  if (v.shareKeys.length) {
    parts.push(sql<SqlBool>`${sql.ref(cols.catalog)} in (select s.catalog_id from catalog_shares s where s.subject_key = any(${sql.val(v.shareKeys)}::text[]) and ${v.permission} = any(s.permissions))`);
  }
  if (v.ownerId) parts.push(sql<SqlBool>`${sql.ref(cols.owner)} = ${v.ownerId}::uuid`);
  return parts.length === 1 ? parts[0]! : sql<SqlBool>`(${sql.join(parts, sql` or `)})`;
}

/** What the caller's subject keys are given on a catalog (any service's `catalog_shares`). */
export async function catalogSharePermissions(db: Kysely<any>, catalogId: string | null, shareKeys: readonly string[]): Promise<Permission[]> {
  if (!catalogId || !shareKeys.length) return [];
  const { rows } = await sql<{ permissions: string[] }>`select permissions from catalog_shares where catalog_id = ${catalogId}::uuid and subject_key = any(${sql.val([...shareKeys])}::text[])`.execute(db);
  return unionPermissions(rows.map((r) => r.permissions));
}
