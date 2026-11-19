import type { Scope } from '@am/core';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

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
