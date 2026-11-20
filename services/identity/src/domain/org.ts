import { AppError, type OrgImportRow, type OrgUnit } from '@am/core';

/** Pure rules for the organization tree. */

export function childPath(parent: Pick<OrgUnit, 'path'> | null, id: string): string[] {
  return [...(parent?.path ?? []), id];
}

/** A unit can't move under itself or one of its descendants. */
export function assertValidParent(unitId: string, parent: Pick<OrgUnit, 'id' | 'path' | 'archived'> | null): void {
  if (!parent) return;
  if (parent.id === unitId || parent.path.includes(unitId)) throw AppError.validation('A unit cannot be placed inside itself or one of its own sub-units');
  if (parent.archived) throw AppError.validation('The parent unit is archived');
}

export function unitKey(path: readonly string[], taken: ReadonlySet<string>): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  let base = path.map(slug).filter(Boolean).join('__').slice(0, 44) || 'unit';
  if (!/^[a-z]/.test(base)) base = `u_${base}`.slice(0, 44);
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}

export interface ImportStep {
  line: number;
  /** Full name path of the unit. */
  path: string[];
  /** Name path of its parent (empty for top level). */
  parentPath: string[];
  existingId: string | null;
  kind: string;
  members: string[];
  managers: string[];
  /** Created implicitly because a deeper line needed it. */
  implicit: boolean;
}

/**
 * Turns pasted rows into ordered create/update steps (parents before children),
 * matching existing units by their name path, case-insensitively. Directory
 * links on an existing unit are merged, never removed.
 */
export function planImport(rows: OrgImportRow[], existing: ReadonlyArray<Pick<OrgUnit, 'id' | 'name' | 'path' | 'directoryMembers' | 'directoryManagers'>>, kinds: string[]): ImportStep[] {
  const byId = new Map(existing.map((u) => [u.id, u]));
  const keyOf = (names: readonly string[]) => names.map((n) => n.toLowerCase()).join('\u0000');
  const existingByNamePath = new Map(existing.map((u) => [keyOf(u.path.map((id) => byId.get(id)?.name ?? '')), u]));
  const steps = new Map<string, ImportStep>();
  const kindFor = (depth: number) => kinds[Math.min(depth, kinds.length - 1)] ?? 'Team';

  for (const row of rows) {
    for (let depth = 1; depth <= row.path.length; depth++) {
      const path = row.path.slice(0, depth);
      const k = keyOf(path);
      const explicit = depth === row.path.length;
      const found = existingByNamePath.get(k);
      const prev = steps.get(k);
      const step: ImportStep = prev ?? {
        line: row.line,
        path,
        parentPath: path.slice(0, -1),
        existingId: found?.id ?? null,
        kind: kindFor(depth - 1),
        members: [...(found?.directoryMembers ?? [])],
        managers: [...(found?.directoryManagers ?? [])],
        implicit: !explicit,
      };
      if (explicit) {
        step.implicit = false;
        step.line = row.line;
        step.members = [...new Set([...step.members, ...row.members])];
        step.managers = [...new Set([...step.managers, ...row.managers])];
      }
      steps.set(k, step);
    }
  }
  return [...steps.values()].sort((a, b) => a.path.length - b.path.length);
}
