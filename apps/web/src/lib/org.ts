import { atLeast, effectiveLevel, type AccessLevel, type Me, type OrgUnit } from '@am/core';
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

    const levelOn = (unitId: string, assetTypeId = ''): AccessLevel => {
      const u = unitById.get(unitId);
      return me && u ? effectiveLevel(me, { unitPath: u.path, assetTypeId }) : 'none';
    };
    return {
      me: me as Me | undefined,
      mine,
      requestTargets,
      levelOn,
      canEditIn: (unitId: string, assetTypeId?: string) => atLeast(levelOn(unitId, assetTypeId), 'edit'),
    };
  }, [me, unitById, units]);
}
