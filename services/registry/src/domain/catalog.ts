import { AppError, shareSubjectKey, type CatalogChanged, type CatalogShare, type ShareLevel } from '@am/core';

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
  level: ShareLevel;
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

export function parseSubjectKey(key: string): Pick<CatalogShare, 'subjectKind' | 'subjectId'> {
  const [kind, id] = key.split(':') as ['unit' | 'user', string];
  return { subjectKind: kind, subjectId: id };
}

export const subjectKeyOf = (s: Pick<CatalogShare, 'subjectKind' | 'subjectId'>) => shareSubjectKey(s.subjectKind, s.subjectId);

export function catalogChangedEvent(c: Pick<CatalogState, 'id' | 'unitId' | 'name' | 'shares' | 'version'>, deleted = false): CatalogChanged {
  return { catalogId: c.id, unitId: c.unitId, name: c.name, deleted, shares: deleted ? [] : c.shares.map((s) => ({ subjectKey: s.subjectKey, level: s.level })), version: c.version };
}
