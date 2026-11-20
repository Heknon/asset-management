import { fieldKindMeta, type DateKind, type FieldDefinition, type FieldKind } from '@am/core';
import { t, tMaybe } from './i18n';
import { slugKey } from './utils';

/**
 * Fields most templates need, ready to drop in with sensible settings, so a
 * template takes a few clicks instead of configuring each field by hand.
 */
export interface FieldPreset {
  /** The field's key: stable English, whatever the language of `label`. */
  key: string;
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
  { key: 'vendor', label: t('Vendor'), kind: 'text', hint: t('Who you buy it from'), showInTable: true },
  { key: 'cost', label: t('Cost'), kind: 'currency', hint: t('Counts toward spend'), config: { currency: 'USD', countsTowardSpend: true }, showInTable: true },
  { key: 'renewal_date', label: t('Renewal date'), kind: 'date', hint: t('Tracked, reminds'), dateKind: 'renewal', showInTable: true },
  { key: 'expiry_date', label: t('Expiry date'), kind: 'date', hint: t('Tracked, reminds'), dateKind: 'expiry', showInTable: true },
  { key: 'warranty_end', label: t('Warranty end'), kind: 'date', hint: t('Tracked, reminds'), dateKind: 'warranty_end' },
  { key: 'purchase_date', label: t('Purchase date'), kind: 'date', hint: t('When it started'), dateKind: 'start' },
  { key: 'seats', label: t('Seats'), kind: 'number', hint: t('Whole number'), config: { integer: true, min: 0 }, showInTable: true },
  { key: 'serial_number', label: t('Serial number'), kind: 'text', hint: t('Single line') },
  { key: 'contact', label: t('Contact'), kind: 'user', hint: t('A person to ask') },
  { key: 'website', label: t('Website'), kind: 'url', hint: t('Portal or product page') },
  { key: 'license_key', label: t('License key'), kind: 'secret', hint: t('Always restricted') },
  { key: 'notes', label: t('Notes'), kind: 'longText', hint: t('Anything else') },
];

const defaults = (kind: FieldKind): Record<string, unknown> =>
  kind === 'select' || kind === 'multiSelect'
    ? { options: [{ value: 'option_1', label: t('Option 1') }, { value: 'option_2', label: t('Option 2') }] }
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
  const name = label ?? preset?.label ?? tMaybe(fieldKindMeta[kind].label);
  // Keys stay English (and readable) when the label is the preset's or the kind's translated name.
  const keyFrom = label ?? preset?.key ?? fieldKindMeta[kind].label;
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
    key: uniqueKey(keyFrom, existing),
    label: name,
    required: preset?.required ?? false,
    restricted: false,
    showInTable: preset?.showInTable ?? false,
    kind,
    config,
  } as FieldDefinition;
}
