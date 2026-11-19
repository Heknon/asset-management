import { describe, expect, it } from 'vitest';
import {
  addDuration,
  advanceRecurringDate,
  assetTypeInputSchema,
  defaultDateKinds,
  effectiveLevel,
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
  const pcA = '11111111-1111-4111-8111-111111111111';
  const pcB = '22222222-2222-4222-8222-222222222222';
  const type = '33333333-3333-4333-8333-333333333333';
  const principal = {
    isAdmin: false,
    grants: [
      { purchaseClassId: pcA, assetTypeId: null, level: 'view' as const },
      { purchaseClassId: pcA, assetTypeId: type, level: 'edit' as const },
    ],
  };

  it('takes the highest matching grant', () => {
    expect(effectiveLevel(principal, { purchaseClassId: pcA, assetTypeId: type })).toBe('edit');
    expect(effectiveLevel(principal, { purchaseClassId: pcA, assetTypeId: pcB })).toBe('view');
    expect(effectiveLevel(principal, { purchaseClassId: pcB, assetTypeId: type })).toBe('none');
    expect(effectiveLevel({ isAdmin: true, grants: [] }, { purchaseClassId: pcB, assetTypeId: type })).toBe('manage');
  });

  it('builds query scopes and consolidates grants', () => {
    expect(scopesFor(principal, 'edit')).toEqual([{ purchaseClassId: pcA, assetTypeId: type }]);
    expect(consolidateGrants([...principal.grants, { purchaseClassId: pcA, assetTypeId: null, level: 'manage' }])).toHaveLength(2);
  });
});
