import {
  AppError,
  isRestricted,
  resolveTrackedDates,
  spendOf,
  validateAttributes,
  type AssetChanged,
  type AssetType,
  type Attributes,
  type DateKind,
  type Duration,
} from '@am/core';

/** The registry's view of an asset: all values, unredacted. Redaction happens at the boundary. */
export interface AssetState {
  id: string;
  assetTypeId: string;
  typeVersion: number;
  name: string;
  status: string;
  ownerId: string | null;
  purchaseClassId: string;
  values: Attributes;
  reminderOverrides: Record<string, Duration[]>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type AssetDraft = Omit<AssetState, 'id' | 'version' | 'createdAt' | 'updatedAt'>;

/** Validates attribute values against the type, or throws a field-addressed validation error. */
export function validatedValues(type: AssetType, raw: Record<string, unknown>): Attributes {
  const { values, issues } = validateAttributes(type, raw);
  if (issues.length) {
    throw AppError.validation('Some fields are invalid', { fields: Object.fromEntries(issues.map((i) => [i.field, i.message])) });
  }
  return values;
}

export function resolveStatus(type: AssetType, status: string | undefined): string {
  if (status === undefined) return type.statuses[0]!.value;
  if (!type.statuses.some((s) => s.value === status)) throw AppError.validation(`Unknown status "${status}"`);
  return status;
}

/** Reminder overrides may only target tracked date fields of the type. */
export function validatedOverrides(type: AssetType, overrides: Record<string, Duration[]>): Record<string, Duration[]> {
  for (const key of Object.keys(overrides)) {
    const f = type.fields.find((x) => x.key === key);
    if (!f || f.kind !== 'date' || !f.config.tracking) throw AppError.validation(`"${key}" is not a tracked date`);
  }
  return overrides;
}

/** Restricted values are stored separately so search and listings never touch them. */
export function splitRestricted(type: Pick<AssetType, 'fields'>, values: Attributes): { open: Attributes; restricted: Attributes } {
  const restrictedKeys = new Set(type.fields.filter(isRestricted).map((f) => f.key));
  const open: Attributes = {};
  const restricted: Attributes = {};
  for (const [k, v] of Object.entries(values)) (restrictedKeys.has(k) ? restricted : open)[k] = v;
  return { open, restricted };
}

const MASK = '••••••';

/** Field-level change log; restricted values are recorded as changed but never stored. */
export function diff(type: Pick<AssetType, 'fields'>, before: Partial<AssetDraft> | null, after: AssetDraft): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const key of ['name', 'status', 'ownerId', 'purchaseClassId'] as const) {
    if (!same(before?.[key], after[key])) changes[key] = { from: before?.[key] ?? null, to: after[key] };
  }
  for (const f of type.fields) {
    const from = before?.values?.[f.key];
    const to = after.values[f.key];
    if (same(from, to)) continue;
    changes[`attributes.${f.key}`] = isRestricted(f) ? { from: from === undefined ? null : MASK, to: to === undefined ? null : MASK } : { from: from ?? null, to: to ?? null };
  }
  if (!same(before?.reminderOverrides, after.reminderOverrides)) changes.reminderOverrides = { from: before?.reminderOverrides ?? null, to: after.reminderOverrides };
  return changes;
}

/** Builds the integration event the scheduler (and others) consume. */
export function assetChangedEvent(
  asset: AssetState,
  type: AssetType,
  kinds: ReadonlyMap<string, DateKind>,
  advanced?: AssetChanged['advanced'],
): AssetChanged {
  return {
    assetId: asset.id,
    name: asset.name,
    assetTypeId: type.id,
    assetTypeName: type.name,
    purchaseClassId: asset.purchaseClassId,
    ownerId: asset.ownerId,
    status: asset.status,
    active: type.statuses.find((s) => s.value === asset.status)?.active ?? true,
    spend: spendOf(type.fields, asset.values),
    trackedDates: resolveTrackedDates(type, asset.values, kinds, asset.reminderOverrides),
    ...(advanced && { advanced }),
    version: asset.version,
  };
}
