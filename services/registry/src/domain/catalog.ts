import { AppError, type CatalogChanged, type Permission } from '@am/core';

/** The registry's view of a catalog. */
export interface CatalogState {
  id: string;
  unitId: string;
  /** The owning unit's ancestor chain (root first, ending with the unit). */
  unitPath: string[];
  name: string;
  description: string | null;
  icon: string;
  color: string;
  version: number;
  assetCount: number;
  shares: ShareRow[];
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShareRow {
  subjectKey: string;
  permissions: Permission[];
  createdByName: string;
  createdAt: Date;
}

/**
 * A catalog holds assets of its unit and everything beneath it: a division's
 * "Labs" catalog can collect equipment owned by any of its teams.
 */
export function assertFitsCatalog(catalog: Pick<CatalogState, 'unitId' | 'name'>, assetUnitPath: readonly string[]): void {
  if (!assetUnitPath.includes(catalog.unitId)) {
    throw AppError.validation(`"${catalog.name}" holds assets of its own unit and the teams beneath it; pick a team inside it, or another catalog`);
  }
}

export function catalogChangedEvent(c: Pick<CatalogState, 'id' | 'unitId' | 'name' | 'shares' | 'version'>, deleted = false): CatalogChanged {
  return { catalogId: c.id, unitId: c.unitId, name: c.name, deleted, shares: deleted ? [] : c.shares.map((s) => ({ subjectKey: s.subjectKey, permissions: s.permissions })), version: c.version };
}
