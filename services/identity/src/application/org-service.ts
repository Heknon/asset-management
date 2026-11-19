import { AppError, orgUnitInputSchema, parseOrgImport, type OrgImport, type OrgImportResult, type OrgUnit, type OrgUnitInput, type Principal } from '@am/core';
import { assertValidParent, childPath, planImport, unitKey } from '../domain/org.js';
import type { IdentityStore } from './ports.js';

const PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#f43f5e', '#14b8a6'];

/** The organization tree: units, their directory links, and who belongs to them. */
export class OrgService {
  constructor(private readonly store: IdentityStore) {}

  list(includeArchived = false) {
    return this.store.listUnits(includeArchived);
  }

  async get(id: string): Promise<OrgUnit> {
    const unit = await this.store.getUnit(id);
    if (!unit) throw AppError.notFound('Unit');
    return unit;
  }

  async create(input: OrgUnitInput): Promise<OrgUnit> {
    return this.store.transaction(async (tx) => {
      const parent = input.parentId ? await tx.getUnit(input.parentId) : null;
      if (input.parentId && !parent) throw AppError.validation('Unknown parent unit');
      if (parent?.archived) throw AppError.validation('The parent unit is archived');
      const unit = await tx.createUnit(input, parent?.path ?? []);
      await tx.syncUnitDirectory(unit.id);
      await tx.publishUnitChanged([unit.id]);
      return (await tx.getUnit(unit.id))!;
    });
  }

  /**
   * Renames, re-links or moves a unit. Moving rewrites the paths of the whole
   * subtree, so access, rollups and reminders follow the reorganisation at once.
   */
  async update(id: string, input: OrgUnitInput): Promise<OrgUnit> {
    return this.store.transaction(async (tx) => {
      const current = await tx.getUnit(id);
      if (!current) throw AppError.notFound('Unit');
      const parent = input.parentId ? await tx.getUnit(input.parentId) : null;
      if (input.parentId && !parent) throw AppError.validation('Unknown parent unit');
      assertValidParent(id, parent);
      const moved = await tx.updateUnit(id, input, childPath(parent, id));
      const linksChanged =
        current.directoryMembers.join('\n') !== input.directoryMembers.join('\n') ||
        current.directoryManagers.join('\n') !== input.directoryManagers.join('\n') ||
        current.archived !== input.archived;
      if (linksChanged) await tx.syncUnitDirectory(id);
      await tx.publishUnitChanged([id, ...moved]);
      return (await tx.getUnit(id))!;
    });
  }

  /** Paste an org chart; missing parents are created, existing units updated. */
  async import(input: OrgImport): Promise<OrgImportResult> {
    const { rows, errors } = parseOrgImport(input.text);
    if (!rows.length) return { created: 0, updated: 0, errors: errors.length ? errors : [{ line: 0, message: 'Nothing to import' }] };
    return this.store.transaction(async (tx) => {
      const existing = await tx.listUnits(true);
      const steps = planImport(rows, existing, input.kinds);
      const keys = await tx.unitKeys();
      const idByPath = new Map<string, string>();
      const pathKey = (p: string[]) => p.map((x) => x.toLowerCase()).join('\u0000');
      const byId = new Map(existing.map((u) => [u.id, u]));
      let created = 0;
      let updated = 0;
      let divisionIndex = existing.filter((u) => u.path.length === 2).length;
      const touched: string[] = [];

      for (const step of steps) {
        const parentId = step.parentPath.length ? (idByPath.get(pathKey(step.parentPath)) ?? null) : null;
        if (step.existingId) {
          idByPath.set(pathKey(step.path), step.existingId);
          const u = byId.get(step.existingId)!;
          const merged = { ...u, directoryMembers: step.members, directoryManagers: step.managers };
          if (merged.directoryMembers.join() !== u.directoryMembers.join() || merged.directoryManagers.join() !== u.directoryManagers.join()) {
            await tx.updateUnit(u.id, orgUnitInputSchema.parse({ ...merged, description: u.description }), u.path);
            await tx.syncUnitDirectory(u.id);
            touched.push(u.id);
            updated++;
          }
          continue;
        }
        const parent = parentId ? (byId.get(parentId) ?? (await tx.getUnit(parentId))) : null;
        const key = unitKey(step.path, keys);
        keys.add(key);
        // Divisions get distinct colors; everything beneath inherits its division's color.
        const color = !parent ? '#6366f1' : parent.path.length === 1 ? PALETTE[divisionIndex++ % PALETTE.length]! : parent.color;
        const unit = await tx.createUnit(
          orgUnitInputSchema.parse({ key, name: step.path[step.path.length - 1], kind: step.kind, parentId, color, directoryMembers: step.members, directoryManagers: step.managers }),
          parent?.path ?? [],
        );
        byId.set(unit.id, unit);
        idByPath.set(pathKey(step.path), unit.id);
        if (step.members.length || step.managers.length) await tx.syncUnitDirectory(unit.id);
        touched.push(unit.id);
        created++;
      }
      await tx.publishUnitChanged(touched);
      return { created, updated, errors };
    });
  }

  /** Re-sends every unit to the other services (e.g. after restoring a backup or adding a service). */
  async republishAll(): Promise<number> {
    const units = await this.store.listUnits(true);
    await this.store.transaction((tx) => tx.publishUnitChanged(units.map((u) => u.id)));
    return units.length;
  }

  people(unitId: string) {
    return this.store.unitPeople(unitId);
  }

  /**
   * Manual members/managers (contractors, people not in the directory group).
   * Admins and managers of the unit or any unit above it may change them.
   */
  async setPeople(actor: Principal, unitId: string, members: string[], managers: string[]) {
    const unit = await this.get(unitId);
    const managesIt = actor.units.some((u) => u.role === 'manager' && unit.path.includes(u.unitId));
    if (!actor.isAdmin && !managesIt) throw AppError.forbidden('Only administrators and managers of this unit can change its people');
    return this.store.transaction(async (tx) => {
      await tx.setManualPeople(unitId, members, managers);
      await tx.publishUnitChanged([unitId]);
      return tx.unitPeople(unitId);
    });
  }
}
