import { describe, expect, it } from 'vitest';
import {
  defaultRefPrefix,
  formatReference,
  validateVariantStructure,
  withVariant,
  addDuration,
  advanceRecurringDate,
  assetTypeInputSchema,
  defaultDateKinds,
  csvCell,
  csvFilename,
  csvLine,
  accessSchema,
  can,
  canManageTemplates,
  effectivePermissions,
  fromMask,
  normalizePermissions,
  parseSubjectKey,
  permissionKeys,
  permissionList,
  permissionsOfLevel,
  roleOf,
  roles,
  subjectKeysOf,
  toMask,
  unionPermissions,
  unitPermissions,
  instantiateTemplate,
  mergeAttributes,
  redactAttributes,
  reminderDates,
  resolveTrackedDates,
  scopesFor,
  starterTemplates,
  validateAttributes,
  validateTypeStructure,
  consolidateGrants,
  requestableUnitIds,
  searchTerms,
  prefixTsQuery,
  buildSearchText,
  highlightRuns,
  parseOrgImport,
  type DateKind,
} from './index.js';

const kinds: DateKind[] = defaultDateKinds.map((k, i) => ({
  ...k,
  id: `00000000-0000-4000-8000-00000000000${i}`,
  color: k.color ?? '#000000',
  actionLabel: k.actionLabel ?? 'Complete',
  defaultReminders: k.defaultReminders ?? [],
  archived: false,
}));
const kindById = new Map(kinds.map((k) => [k.id, k]));
const kindIdByKey = new Map(kinds.map((k) => [k.key, k.id]));
const license = assetTypeInputSchema.parse(instantiateTemplate(starterTemplates[0]!, kindIdByKey));

describe('durations', () => {
  it('clamps month arithmetic to month end', () => {
    expect(addDuration('2026-01-31', { amount: 1, unit: 'month' })).toBe('2026-02-28');
    expect(addDuration('2028-02-29', { amount: 1, unit: 'year' })).toBe('2029-02-28');
    expect(addDuration('2026-03-10', { amount: 30, unit: 'day' }, -1)).toBe('2026-02-08');
  });
});

describe('templates', () => {
  it('every starter template is structurally valid', () => {
    for (const t of starterTemplates) {
      const input = assetTypeInputSchema.parse(instantiateTemplate(t, kindIdByKey));
      expect(validateTypeStructure(input, new Set(kindById.keys()))).toEqual([]);
    }
  });

  it('detects derivation cycles and bad references', () => {
    const broken = structuredClone(license);
    const renewal = broken.fields.find((f) => f.key === 'renewal_date')!;
    if (renewal.kind === 'date') renewal.config.tracking!.derive = { from: 'notice_deadline', direction: 'after', amount: { fixed: 1 }, unit: 'day' };
    const issues = validateTypeStructure(broken, new Set(kindById.keys()));
    expect(issues.some((i) => i.message.includes('cycle'))).toBe(true);
  });
});

describe('attributes', () => {
  it('validates, normalises and derives dates', () => {
    const { values, issues } = validateAttributes(license, {
      vendor: 'Acme',
      seats: '25',
      cost_per_term: 1200.456,
      renewal_date: '2027-01-15',
      notice_days: 30,
      notice_deadline: '1999-01-01',
      unknown: 'dropped',
    });
    expect(issues).toEqual([]);
    expect(values).toMatchObject({ seats: 25, cost_per_term: 1200.46, notice_deadline: '2026-12-16' });
    expect(values).not.toHaveProperty('unknown');
  });

  it('reports required and invalid values', () => {
    const { issues } = validateAttributes(license, { seats: 1.5, portal_url: 'ftp://x' });
    expect(issues.map((i) => i.field).sort()).toEqual(['portal_url', 'renewal_date', 'seats', 'vendor']);
  });

  it('protects restricted fields', () => {
    const { merged, blocked } = mergeAttributes(license.fields, { license_key: 'SECRET' }, { license_key: 'NEW', vendor: 'X' }, false);
    expect(blocked).toEqual(['license_key']);
    expect(merged).toMatchObject({ license_key: 'SECRET', vendor: 'X' });
    expect(redactAttributes(license.fields, { license_key: 'SECRET', vendor: 'X' }, false)).toEqual({ vendor: 'X' });
  });
});

describe('tracked dates', () => {
  const { values } = validateAttributes(license, { vendor: 'Acme', renewal_date: '2027-01-15', notice_days: 30, term_months: 12 });

  it('resolves semantics from date kinds and fields', () => {
    const tracked = resolveTrackedDates(license, values, kindById);
    expect(tracked.map((t) => [t.fieldKey, t.dateKind.key, t.date])).toEqual([
      ['notice_deadline', 'notice_deadline', '2026-12-16'],
      ['renewal_date', 'renewal', '2027-01-15'],
    ]);
    expect(tracked[1]!.recurrence).toEqual({ amount: 12, unit: 'month' });
    expect(reminderDates(tracked[1]!)).toEqual(['2026-10-17', '2026-11-16', '2026-12-16', '2027-01-08']);
  });

  it('applies per-asset reminder overrides', () => {
    const [, renewal] = resolveTrackedDates(license, values, kindById, { renewal_date: [{ amount: 1, unit: 'day' }] });
    expect(renewal!.reminders).toEqual([{ amount: 1, unit: 'day' }]);
  });

  it('advances recurring dates and recomputes derived ones', () => {
    const r = advanceRecurringDate(license, values, 'renewal_date', kindById);
    expect(r).toMatchObject({ from: '2027-01-15', to: '2028-01-15' });
    expect(r.values.notice_deadline).toBe('2027-12-16');
    expect(() => advanceRecurringDate(license, values, 'notice_deadline', kindById)).toThrow(/derived/);
  });
});

describe('permissions', () => {
  const root = '00000000-0000-4000-8000-0000000000aa';
  const rnd = '11111111-1111-4111-8111-111111111111';
  const team = '22222222-2222-4222-8222-222222222222';
  const sales = '44444444-4444-4444-8444-444444444444';
  const type = '33333333-3333-4333-8333-333333333333';
  const principal = {
    isAdmin: false,
    grants: [
      { unitId: rnd, assetTypeId: null, permissions: [...roles.viewer.permissions] },
      { unitId: team, assetTypeId: type, permissions: [...roles.editor.permissions] },
    ],
  };
  const perms = (scope: Parameters<typeof effectivePermissions>[1], p = principal) => permissionList(effectivePermissions(p, scope));

  it('applies grants to the whole subtree and adds them up', () => {
    expect(perms({ unitPath: [root, rnd, team], assetTypeId: type })).toEqual(roles.editor.permissions);
    expect(perms({ unitPath: [root, rnd, team], assetTypeId: 'other' })).toEqual(['view']);
    expect(perms({ unitPath: [root, rnd], assetTypeId: type })).toEqual(['view']);
    expect(perms({ unitPath: [root, sales], assetTypeId: type })).toEqual([]);
    expect(perms({ unitPath: [root, sales], assetTypeId: type }, { isAdmin: true, grants: [] })).toEqual([...permissionKeys]);
    expect(can(principal, 'edit', { unitPath: [root, rnd, team], assetTypeId: type })).toBe(true);
    expect(can(principal, 'delete', { unitPath: [root, rnd, team], assetTypeId: type })).toBe(false);
  });

  it('builds query scopes and consolidates grants', () => {
    expect(scopesFor(principal, 'edit')).toEqual([{ unitId: team, assetTypeId: type }]);
    const merged = consolidateGrants([...principal.grants, { unitId: rnd, assetTypeId: null, permissions: ['view', 'comment'] }]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.permissions).toEqual(['view', 'comment']);
  });

  it('recognises roles and keeps custom sets canonical', () => {
    expect(roleOf(['view', 'comment'])).toBe('commenter');
    expect(roleOf(['export'])).toBe('custom');
    expect(normalizePermissions(['export', 'export', 'attach'])).toEqual(['view', 'attach', 'export']);
    expect(fromMask(toMask(roles.editor.permissions))).toEqual(roles.editor.permissions);
    expect(accessSchema.parse({ role: 'contributor' })).toEqual(roles.contributor.permissions);
    expect(accessSchema.safeParse({ role: 'custom', permissions: [] }).success).toBe(false);
    expect(permissionsOfLevel('manage')).toEqual([...permissionKeys]);
  });

  it('only lets type-wide managers of the company change templates', () => {
    expect(canManageTemplates({ isAdmin: false, grants: [{ unitId: root, assetTypeId: null, permissions: [...permissionKeys] }] }, [root])).toBe(true);
    expect(canManageTemplates({ isAdmin: false, grants: [{ unitId: rnd, assetTypeId: null, permissions: [...permissionKeys] }] }, [root])).toBe(false);
    expect(unitPermissions(principal, [root, rnd, team]).has('edit')).toBe(false);
  });

  it('lets people request for their units and every unit above them', () => {
    const paths: Record<string, string[]> = { [team]: [root, rnd, team] };
    const allowed = requestableUnitIds({ isAdmin: false, units: [{ unitId: team, role: 'member' }] }, (id) => paths[id]);
    expect(allowed).toEqual(new Set([root, rnd, team]));
  });
});

describe('search', () => {
  it('normalises terms across scripts and accents', () => {
    expect(searchTerms('Café  Figma-Enterprise, café')).toEqual(['cafe', 'figma', 'enterprise']);
    expect(prefixTsQuery('ad cc')).toBe('ad:* & cc:*');
    expect(prefixTsQuery('  --  ')).toBeNull();
  });

  it('indexes labelled values but never restricted ones', () => {
    const text = buildSearchText(license, 'GitHub', { vendor: 'GitHub', seats: 120, license_key: 'SECRET', auto_renews: true }, 'Dana', {
      typeName: 'Software license',
      statusLabel: 'Active',
      unitName: 'Platform',
      personName: () => undefined,
    });
    expect(text).toContain('Vendor: GitHub');
    expect(text).toContain('Team: Platform');
    expect(text).toContain('Auto-renews: yes');
    expect(text).not.toContain('SECRET');
  });

  it('splits highlighted snippets safely', () => {
    expect(highlightRuns('Vendor: «Fig»ma <b>')).toEqual([
      { text: 'Vendor: ', hit: false },
      { text: 'Fig', hit: true },
      { text: 'ma <b>', hit: false },
    ]);
  });

  it('parses pasted org charts', () => {
    const { rows, errors } = parseOrgImport('# org\nWix / R&D / Editor\nWix › R&D › Editor › Platform | CN=platform,DC=wix ; department=Platform | CN=leads\n | x');
    expect(rows).toEqual([
      { line: 2, path: ['Wix', 'R&D', 'Editor'], members: [], managers: [] },
      { line: 3, path: ['Wix', 'R&D', 'Editor', 'Platform'], members: ['CN=platform,DC=wix', 'department=Platform'], managers: ['CN=leads'] },
    ]);
    expect(errors).toEqual([{ line: 4, message: 'Missing unit path' }]);
  });
});

describe('catalog shares', () => {
  const division = '00000000-0000-4000-8000-00000000000d';
  const team = '00000000-0000-4000-8000-00000000000e';
  const paths = new Map([[team, [division, team]]]);

  it('reaches a person directly, through their groups, units and every ancestor unit', () => {
    const keys = subjectKeysOf({ userId: 'u1', units: [{ unitId: team, role: 'member' }] }, (id) => paths.get(id), ['g1']);
    expect(keys).toEqual(['user:u1', 'group:g1', `unit:${division}`, `unit:${team}`]);
    expect(parseSubjectKey('group:g1')).toEqual({ kind: 'group', id: 'g1' });
  });

  it('adds what shares give to what the org chart gives', () => {
    const p = { isAdmin: false, grants: [{ unitId: division, assetTypeId: null, permissions: ['view' as const] }] };
    expect(permissionList(effectivePermissions(p, { unitPath: [division], assetTypeId: 't', shared: ['view', 'comment'] }))).toEqual(['view', 'comment']);
    expect(unionPermissions([['view'], ['view', 'attach']])).toEqual(['view', 'attach']);
  });
});

describe('csv', () => {
  it('quotes, escapes and defuses formulas', () => {
    expect(csvLine(['a', 'b,c', 'say "hi"', null, 12, -3.5])).toBe('a,"b,c","say ""hi""",,12,-3.5\r\n');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvFilename('Licenses: R&D / Labs', '2026-11-19')).toBe('Licenses R&D Labs 2026-11-19.csv');
  });
});

describe('team variants and new field kinds', () => {
  const kinds = new Map(defaultDateKinds.map((k, i) => [`k${i}`, { ...k, id: `00000000-0000-4000-8000-00000000000${i}` }]));
  const kindIds = new Set([...kinds.values()].map((k) => k.id));
  const base = instantiateTemplate(starterTemplates[0]!, new Map([...kinds.values()].map((k) => [k.key, k.id])));
  const mac = { id: '00000000-0000-4000-8000-0000000000f1', key: 'macs', label: 'MAC addresses', kind: 'list' as const, required: false, restricted: false, showInTable: true, config: { pattern: '^([0-9A-F]{2}:){5}[0-9A-F]{2}$', maxItems: 10 } };
  const variant = { unitId: '00000000-0000-4000-8000-0000000000aa', name: 'Design license', description: null, sections: ['Workstation'], fields: [{ ...mac, section: 'Workstation' }] };

  it('extends a template without redefining its fields', () => {
    expect(validateVariantStructure({ ...base, statuses: base.statuses }, variant, kindIds)).toEqual([]);
    const clash = { ...variant, fields: [{ ...mac, key: 'vendor' }] };
    expect(validateVariantStructure({ ...base, statuses: base.statuses }, clash, kindIds)[0]!.message).toMatch(/already has a field "vendor"/);
    const merged = withVariant(base, variant);
    expect(merged.fields.at(-1)!.key).toBe('macs');
    expect(merged.sections).toContain('Workstation');
  });

  it('validates list entries one by one', () => {
    const schema = { fields: [mac] };
    expect(validateAttributes(schema, { macs: ['AA:BB:CC:DD:EE:FF', ' AA:BB:CC:DD:EE:FF '] }).values.macs).toEqual(['AA:BB:CC:DD:EE:FF']);
    expect(validateAttributes(schema, { macs: ['not-a-mac'] }).issues[0]!.message).toMatch(/required format: not-a-mac/);
  });

  it('derives readable reference prefixes', () => {
    expect(defaultRefPrefix('software_license')).toBe('SL');
    expect(defaultRefPrefix('hardware')).toBe('HAR');
    expect(formatReference('LIC', 42)).toBe('LIC-42');
  });
});
