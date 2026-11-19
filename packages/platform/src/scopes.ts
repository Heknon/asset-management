import type { Scope } from '@am/core';
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';

/**
 * Turns permission scopes into a WHERE expression over the given columns:
 * `(pc = A AND type = T) OR (pc = B) OR ...`. No scopes ⇒ matches nothing.
 */
export function scopeFilter<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  scopes: readonly Scope[],
  purchaseClassColumn: string,
  assetTypeColumn: string,
): Expression<SqlBool> {
  if (!scopes.length) return sql<SqlBool>`false`;
  if (scopes.some((s) => s.purchaseClassId === null && s.assetTypeId === null)) return sql<SqlBool>`true`;
  const ref = (c: string) => sql.ref(c);
  return eb.or(
    scopes.map((s) => {
      const parts = [
        ...(s.purchaseClassId ? [sql<SqlBool>`${ref(purchaseClassColumn)} = ${s.purchaseClassId}`] : []),
        ...(s.assetTypeId ? [sql<SqlBool>`${ref(assetTypeColumn)} = ${s.assetTypeId}`] : []),
      ];
      return eb.and(parts);
    }),
  );
}
