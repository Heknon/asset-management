import { defaultStatuses, type AssetTypeInput } from './asset-type.js';
import type { FieldDefinition } from './fields.js';

/**
 * Starter templates. They are plain data: a template refers to date kinds by
 * `key`, which is resolved to the installation's ids when instantiated. After
 * that, an instantiated type is an ordinary, fully editable asset type.
 */
type TemplateField = Omit<FieldDefinition, 'id' | 'config'> & { config?: unknown; tracking?: TemplateTracking };
interface TemplateTracking {
  dateKind: string;
  derive?: unknown;
  recurrence?: unknown;
  notify?: unknown;
  confirmBefore?: unknown;
}
export interface AssetTemplate extends Omit<AssetTypeInput, 'fields' | 'statuses'> {
  statuses?: AssetTypeInput['statuses'];
  fields: TemplateField[];
}

const f = (key: string, label: string, kind: FieldDefinition['kind'], extra: Partial<TemplateField> = {}): TemplateField =>
  ({ key, label, kind, required: false, restricted: false, showInTable: false, ...extra }) as TemplateField;

const sel = (...values: string[]) => ({ options: values.map((v) => ({ value: v.toLowerCase().replace(/\W+/g, '_'), label: v })) });

export const starterTemplates: AssetTemplate[] = [
  {
    key: 'software_license',
    refPrefix: 'LIC',
    name: 'Software license',
    description: 'Subscriptions and perpetual licenses with seats, terms and renewals.',
    icon: 'key-round',
    color: '#6366f1',
    statuses: [
      { value: 'active', label: 'Active', color: '#10b981', active: true },
      { value: 'trial', label: 'Trial', color: '#0ea5e9', active: true },
      { value: 'cancelled', label: 'Cancelled', color: '#94a3b8', active: false },
    ],
    sections: ['Commercial', 'Term', 'Access'],
    fields: [
      f('vendor', 'Vendor', 'text', { required: true, showInTable: true, section: 'Commercial' }),
      f('license_id', 'License / contract ID', 'text', { section: 'Commercial' }),
      f('purchase_order', 'Purchase order', 'text', { section: 'Commercial' }),
      f('purchase_date', 'Purchase date', 'date', { section: 'Commercial', tracking: { dateKind: 'start' } }),
      f('seats', 'Seats', 'number', { config: { integer: true, min: 0 }, showInTable: true, section: 'Commercial' }),
      f('cost_per_term', 'Cost per term', 'currency', { config: { currency: 'USD', countsTowardSpend: true }, showInTable: true, section: 'Commercial' }),
      f('term_months', 'Term (months)', 'number', { config: { integer: true, min: 1, unit: 'mo' }, section: 'Term' }),
      f('auto_renews', 'Auto-renews', 'boolean', { section: 'Term' }),
      f('notice_days', 'Notice period (days)', 'number', { config: { integer: true, min: 0, unit: 'd' }, section: 'Term' }),
      f('start_date', 'Start date', 'date', { section: 'Term', tracking: { dateKind: 'start' } }),
      f('renewal_date', 'Renewal date', 'date', {
        required: true,
        showInTable: true,
        section: 'Term',
        tracking: { dateKind: 'renewal', recurrence: { mode: 'field', field: 'term_months', unit: 'month' }, confirmBefore: { amount: 60, unit: 'day' } },
      }),
      f('notice_deadline', 'Cancellation deadline', 'date', {
        showInTable: true,
        section: 'Term',
        tracking: { dateKind: 'notice_deadline', derive: { from: 'renewal_date', direction: 'before', amount: { field: 'notice_days' }, unit: 'day' } },
      }),
      f('license_key', 'License key', 'secret', { section: 'Access' }),
      f('portal_url', 'Admin portal', 'url', { section: 'Access' }),
    ],
  },
  {
    key: 'sim_line',
    refPrefix: 'SIM',
    name: 'SIM / mobile line',
    description: 'SIM cards and mobile plans with contract end dates.',
    icon: 'smartphone',
    color: '#0ea5e9',
    statuses: [
      { value: 'active', label: 'Active', color: '#10b981', active: true },
      { value: 'suspended', label: 'Suspended', color: '#f59e0b', active: true },
      { value: 'terminated', label: 'Terminated', color: '#94a3b8', active: false },
    ],
    sections: ['Line', 'Plan'],
    fields: [
      f('msisdn', 'Phone number', 'text', { required: true, showInTable: true, section: 'Line', config: { pattern: '^\\+?[0-9 ]{6,20}$', placeholder: '+1 555 0100' } }),
      f('iccid', 'ICCID', 'text', { section: 'Line', config: { pattern: '^[0-9]{18,22}$' } }),
      f('puk', 'PUK', 'secret', { section: 'Line' }),
      f('assignee', 'Assigned to', 'user', { showInTable: true, section: 'Line' }),
      f('carrier', 'Carrier', 'text', { showInTable: true, section: 'Plan' }),
      f('plan', 'Plan', 'select', { section: 'Plan', config: sel('Voice only', 'Voice + data', 'Data only', 'IoT') }),
      f('monthly_cost', 'Monthly cost', 'currency', { section: 'Plan', config: { currency: 'USD', countsTowardSpend: true }, showInTable: true }),
      f('contract_end', 'Contract end', 'date', {
        showInTable: true,
        section: 'Plan',
        tracking: { dateKind: 'expiry', notify: { owner: true, userFields: ['assignee'], emails: [], unitManagers: 'fallback' } },
      }),
    ],
  },
  {
    key: 'hardware',
    refPrefix: 'HW',
    name: 'Hardware',
    description: 'Laptops, servers and devices with warranty tracking.',
    icon: 'laptop',
    color: '#10b981',
    sections: ['Device', 'Purchase'],
    fields: [
      f('serial', 'Serial number', 'text', { required: true, showInTable: true, section: 'Device' }),
      f('model', 'Model', 'text', { showInTable: true, section: 'Device' }),
      f('assignee', 'Assigned to', 'user', { showInTable: true, section: 'Device' }),
      f('purchase_price', 'Purchase price', 'currency', { section: 'Purchase', config: { currency: 'USD', countsTowardSpend: false } }),
      f('purchase_date', 'Purchase date', 'date', { section: 'Purchase', tracking: { dateKind: 'start' } }),
      f('warranty_end', 'Warranty end', 'date', { showInTable: true, section: 'Purchase', tracking: { dateKind: 'warranty_end' } }),
    ],
  },
  {
    key: 'domain_certificate',
    refPrefix: 'DOM',
    name: 'Domain / certificate',
    description: 'Domains and TLS certificates that must never lapse.',
    icon: 'globe',
    color: '#f59e0b',
    sections: [],
    fields: [
      f('fqdn', 'Domain', 'text', { required: true, showInTable: true }),
      f('registrar', 'Registrar / CA', 'text', { showInTable: true }),
      f('annual_cost', 'Annual cost', 'currency', { config: { currency: 'USD', countsTowardSpend: true } }),
      f('expires_on', 'Expires on', 'date', { required: true, showInTable: true, tracking: { dateKind: 'renewal', recurrence: { mode: 'fixed', every: { amount: 1, unit: 'year' } }, confirmBefore: { amount: 45, unit: 'day' } } }),
    ],
  },
];

/** Turns a template into an asset type input, resolving date kind keys to ids. */
export function instantiateTemplate(template: AssetTemplate, dateKindIdByKey: ReadonlyMap<string, string>): AssetTypeInput {
  const fields = template.fields.map(({ tracking, config, ...rest }) => {
    const resolved: Record<string, unknown> = { ...(config as object) };
    if (tracking) {
      const dateKindId = dateKindIdByKey.get(tracking.dateKind);
      if (!dateKindId) throw new Error(`Template "${template.key}" needs date kind "${tracking.dateKind}"`);
      const { dateKind: _ignored, ...trackingRest } = tracking;
      resolved.tracking = { dateKindId, notify: { owner: true, userFields: [], emails: [], unitManagers: 'fallback' }, ...trackingRest };
    }
    return { id: globalThis.crypto.randomUUID(), ...rest, config: resolved } as FieldDefinition;
  });
  return { ...template, statuses: template.statuses ?? defaultStatuses, fields };
}
