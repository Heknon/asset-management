import {
  AppError,
  canManageTemplates,
  normalizePermissions,
  subjectKinds,
  unitPermissions,
  type GrantInput,
  type GrantRecord,
  type Permission,
  type Principal,
  type Subject,
  type SubjectKind,
  type UnitAccess,
} from '@am/core';
import type { IdentityStore } from './ports.js';

/**
 * Who may do what on organization units and the whole organization. Grants go
 * to people, directory groups or units; they reach access tokens at the next
 * token refresh (minutes) or sign-in.
 *
 * Changing a unit's access needs "Manage access" on it (its managers, and
 * Admins above it); the whole organization is changed by administrators and
 * people who manage the company as a whole.
 */
export class AccessService {
  constructor(private readonly store: IdentityStore) {}

  async unitAccess(p: Principal, unitId: string): Promise<UnitAccess> {
    const unit = await this.store.getUnit(unitId);
    if (!unit) throw AppError.notFound('Unit');
    const grants = await this.store.listGrants({ unitIds: [...unit.path, null] });
    const people = await this.store.unitPeople(unitId);
    return {
      unitId,
      direct: grants.filter((g) => g.unitId === unitId),
      inherited: grants.filter((g) => g.unitId !== unitId).map((g) => ({ ...g, fromUnitId: g.unitId })),
      memberRole: unit.memberRole,
      managers: people.filter((x) => x.role === 'manager').map((x) => ({ id: x.id, displayName: x.displayName })),
      canManage: await this.canManage(p, unitId),
    };
  }

  /** Whole-organization grants (Settings → Access). */
  async organizationAccess(p: Principal): Promise<{ grants: GrantRecord[]; canManage: boolean }> {
    return { grants: await this.store.listGrants({ unitIds: [null] }), canManage: await this.canManage(p, null) };
  }

  async grant(p: Principal, input: GrantInput): Promise<GrantRecord> {
    await this.assertCanManage(p, input.unitId);
    return this.store.createGrant(input, p.displayName);
  }

  async update(p: Principal, id: string, permissions: Permission[]): Promise<GrantRecord> {
    const g = await this.store.getGrant(id);
    if (!g) throw AppError.notFound('Access');
    await this.assertCanManage(p, g.unitId);
    return this.store.updateGrant(id, normalizePermissions(permissions));
  }

  async revoke(p: Principal, id: string): Promise<void> {
    const g = await this.store.getGrant(id);
    if (!g) throw AppError.notFound('Access');
    await this.assertCanManage(p, g.unitId);
    await this.store.deleteGrant(id);
  }

  /** People, units and groups to give access to. */
  searchSubjects(q: string, kinds?: string): Promise<Subject[]> {
    const wanted = (kinds?.split(',') ?? [...subjectKinds]).filter((k): k is SubjectKind => (subjectKinds as readonly string[]).includes(k));
    return this.store.searchSubjects(q, wanted.length ? wanted : [...subjectKinds]);
  }

  private async canManage(p: Principal, unitId: string | null): Promise<boolean> {
    const roots = (await this.store.listUnits(false)).filter((u) => !u.parentId).map((u) => u.id);
    if (unitId === null) return canManageTemplates(p, roots);
    const unit = await this.store.getUnit(unitId);
    return !!unit && unitPermissions(p, unit.path).has('manage');
  }

  private async assertCanManage(p: Principal, unitId: string | null) {
    if (!(await this.canManage(p, unitId))) {
      throw AppError.forbidden(unitId ? 'Only people who manage this unit can change who has access to it' : 'Only administrators can change organization-wide access');
    }
  }
}
