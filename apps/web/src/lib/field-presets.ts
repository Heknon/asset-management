import { fieldKindMeta, type DateKind, type FieldDefinition, type FieldKind } from '@am/core';
import { slugKey } from './utils';

/**
 * Fields most templates need, ready to drop in with sensible settings, so a
 * template takes a few clicks instead of configuring each field by hand.
 */
export interface FieldPreset {
  label: string;
  kind: FieldKind;
  hint: string;
  /** Extra settings; `dateKind` names the tracked-date kind by key. */
  config?: Record<string, unknown>;
  dateKind?: string;
  showInTable?: boolean;
  required?: boolean;
}

export const fieldPresets: FieldPreset[] = [
  { label: 'Vendor', kind: 'text', hint: 'Who you buy it from', showInTable: true },
  { label: 'Cost', kind: 'currency', hint: 'Counts toward spend', config: { currency: 'USD', countsTowardSpend: true }, showInTable: true },
  { label: 'Renewal date', kind: 'date', hint: 'Tracked, reminds', dateKind: 'renewal', showInTable: true },
  { label: 'Expiry date', kind: 'date', hint: 'Tracked, reminds', dateKind: 'expiry', showInTable: true },
  { label: 'Warranty end', kind: 'date', hint: 'Tracked, reminds', dateKind: 'warranty_end' },
  { label: 'Purchase date', kind: 'date', hint: 'When it started', dateKind: 'start' },
  { label: 'Seats', kind: 'number', hint: 'Whole number', config: { integer: true, min: 0 }, showInTable: true },
  { label: 'Serial number', kind: 'text', hint: 'Single line' },
  { label: 'Contact', kind: 'user', hint: 'A person to ask' },
  { label: 'Website', kind: 'url', hint: 'Portal or product page' },
  { label: 'License key', kind: 'secret', hint: 'Always restricted' },
  { label: 'Notes', kind: 'longText', hint: 'Anything else' },
];

const defaults = (kind: FieldKind): Record<string, unknown> =>
  kind === 'select' || kind === 'multiSelect'
    ? { options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] }
    : kind === 'currency'
      ? { currency: 'USD', countsTowardSpend: false }
      : kind === 'number'
        ? { integer: false }
        : kind === 'list'
          ? { maxItems: 200 }
          : kind === 'assetRef'
            ? { multiple: false }
            : {};

export function uniqueKey(label: string, existing: ReadonlySet<string>): string {
  const base = slugKey(label) || 'field';
  let key = base;
  for (let i = 2; existing.has(key); i++) key = `${base}_${i}`;
  return key;
}

/** A field of `kind` (named after the kind), or of a preset. */
export function makeField(from: FieldKind | FieldPreset, existing: ReadonlySet<string>, kinds: readonly DateKind[], label?: string): FieldDefinition {
  const preset = typeof from === 'string' ? undefined : from;
  const kind = preset?.kind ?? (from as FieldKind);
  const name = label ?? preset?.label ?? fieldKindMeta[kind].label;
  const config: Record<string, unknown> = { ...defaults(kind), ...preset?.config };
  const dateKind = preset?.dateKind && kinds.find((k) => k.key === preset.dateKind);
  if (dateKind)
    config.tracking = {
      dateKindId: dateKind.id,
      notify: { owner: true, userFields: [], emails: [], unitManagers: 'fallback' },
      confirmBefore: null,
    };
  return {
    id: crypto.randomUUID(),
    key: uniqueKey(name, existing),
    label: name,
    required: preset?.required ?? false,
    restricted: false,
    showInTable: preset?.showInTable ?? false,
    kind,
    config,
  } as FieldDefinition;
}
