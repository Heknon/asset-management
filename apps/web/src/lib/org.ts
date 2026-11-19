import { canManageTemplates, effectivePermissions, unitPermissions, type Me, type OrgUnit, type Permission } from '@am/core';
import { useMemo } from 'react';
import type { UnitOption } from '@/components/pickers';
import { useLookups, useMe } from './queries';

/** The units I belong to or manage, plus helpers built on the org tree. */
export function useMyOrg() {
  const me = useMe().data;
  const { unitById, units } = useLookups();
  return useMemo(() => {
    const mine = (me?.units ?? [])
      .map((u) => ({ unit: unitById.get(u.unitId), role: u.role }))
      .filter((x): x is { unit: OrgUnit; role: 'member' | 'manager' } => !!x.unit)
      .sort((a, b) => (a.role === b.role ? a.unit.name.localeCompare(b.unit.name) : a.role === 'manager' ? -1 : 1));

    /**
     * Who a request can be for: my own units first, then every unit above them
     * ("Your department", "Your division", "Whole company").
     */
    const requestTargets: UnitOption[] = [];
    const seen = new Set<string>();
    for (const { unit, role } of mine) {
      [...unit.path].reverse().forEach((id, depth) => {
        const u = unitById.get(id);
        if (!u || seen.has(id)) return;
        seen.add(id);
        requestTargets.push({ unit: u, hint: depth === 0 ? (role === 'manager' ? 'You manage' : 'Your team') : u.parentId ? `Your ${u.kind.toLowerCase()}` : 'Whole company' });
      });
    }
    if (!requestTargets.length) units.filter((u) => !u.parentId && !u.archived).forEach((u) => requestTargets.push({ unit: u, hint: 'Whole company' }));

    /** My permissions on items of a unit (from the org chart; catalog shares are added by the server per item). */
    const permissionsOn = (unitId: string, assetTypeId = ''): Set<Permission> => {
      const u = unitById.get(unitId);
      return me && u ? effectivePermissions(me, { unitPath: u.path, assetTypeId }) : new Set();
    };
    /** My permissions on the unit itself (its access, catalogs, team templates). */
    const unitPermissionsOn = (unitId: string): Set<Permission> => {
      const u = unitById.get(unitId);
      return me && u ? unitPermissions(me, u.path) : new Set();
    };
    return {
      me: me as Me | undefined,
      mine,
      requestTargets,
      permissionsOn,
      unitPermissionsOn,
      /** Templates, date kinds and organization-wide access (admins, and e.g. Procurement as Admin of the company). */
      canManageOrganization: !!me && canManageTemplates(me, units.filter((u) => !u.parentId).map((u) => u.id)),
      can: (unitId: string, permission: Permission, assetTypeId?: string) => permissionsOn(unitId, assetTypeId).has(permission),
    };
  }, [me, unitById, units]);
}

/** The types this person can add items of (the palette's "New laptop", …). */
export function useCreatableTypes() {
  const { me, can } = useMyOrg();
  const { units, types } = useLookups();
  return types.filter((t) => !t.archived && (!!me?.isAdmin || units.some((u) => can(u.id, 'create', t.id))));
}
