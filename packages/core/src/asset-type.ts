import { z } from 'zod';
import { fieldDefinitionSchema, fieldKeySchema, type FieldDefinition } from './fields.js';

export const statusSchema = z.object({
  value: fieldKeySchema,
  label: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Inactive statuses (retired, cancelled) suppress reminders. */
  active: z.boolean().default(true),
});
export type AssetStatus = z.infer<typeof statusSchema>;

export const defaultStatuses: AssetStatus[] = [
  { value: 'active', label: 'Active', color: '#10b981', active: true },
  { value: 'pending', label: 'Pending', color: '#f59e0b', active: true },
  { value: 'retired', label: 'Retired', color: '#94a3b8', active: false },
];

export const assetTypeInputSchema = z.object({
  key: fieldKeySchema,
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  icon: z.string().max(40).default('box'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  statuses: z.array(statusSchema).min(1).default(defaultStatuses),
  sections: z.array(z.string().min(1).max(60)).default([]),
  fields: z.array(fieldDefinitionSchema).max(200),
});
export type AssetTypeInput = z.infer<typeof assetTypeInputSchema>;

export const assetTypeSchema = assetTypeInputSchema.extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssetType = z.infer<typeof assetTypeSchema>;

export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * Structural rules that a single field cannot express on its own:
 * unique keys, valid cross-field references and acyclic derivations.
 */
export function validateTypeStructure(input: AssetTypeInput, knownDateKindIds: ReadonlySet<string>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const byKey = new Map<string, FieldDefinition>();

  input.fields.forEach((field, i) => {
    if (byKey.has(field.key)) issues.push({ path: `fields.${i}.key`, message: `Duplicate field key "${field.key}"` });
    byKey.set(field.key, field);
    if (field.section && !input.sections.includes(field.section)) {
      issues.push({ path: `fields.${i}.section`, message: `Unknown section "${field.section}"` });
    }
  });

  const statusValues = new Set<string>();
  input.statuses.forEach((s, i) => {
    if (statusValues.has(s.value)) issues.push({ path: `statuses.${i}.value`, message: `Duplicate status "${s.value}"` });
    statusValues.add(s.value);
  });

  const expectKind = (path: string, key: string, kinds: FieldDefinition['kind'][]) => {
    const target = byKey.get(key);
    if (!target) issues.push({ path, message: `References unknown field "${key}"` });
    else if (!kinds.includes(target.kind)) issues.push({ path, message: `Field "${key}" must be of type ${kinds.join(' or ')}` });
  };

  input.fields.forEach((field, i) => {
    if ((field.kind === 'select' || field.kind === 'multiSelect') && new Set(field.config.options.map((o) => o.value)).size !== field.config.options.length) {
      issues.push({ path: `fields.${i}.config.options`, message: 'Option values must be unique' });
    }
    if (field.kind !== 'date' || !field.config.tracking) return;
    const t = field.config.tracking;
    const p = `fields.${i}.config.tracking`;
    if (!knownDateKindIds.has(t.dateKindId)) issues.push({ path: `${p}.dateKindId`, message: 'Unknown date kind' });
    if (t.derive) {
      if (t.derive.from === field.key) issues.push({ path: `${p}.derive.from`, message: 'A date cannot be derived from itself' });
      else expectKind(`${p}.derive.from`, t.derive.from, ['date']);
      if ('field' in t.derive.amount) expectKind(`${p}.derive.amount.field`, t.derive.amount.field, ['number']);
    }
    if (t.recurrence?.mode === 'field') expectKind(`${p}.recurrence.field`, t.recurrence.field, ['number']);
    t.notify.userFields.forEach((k, j) => expectKind(`${p}.notify.userFields.${j}`, k, ['user']));
  });

  const cycle = findDerivationCycle(input.fields);
  if (cycle) issues.push({ path: 'fields', message: `Derived dates form a cycle: ${cycle.join(' → ')}` });

  return issues;
}

/** Returns derivation order (sources before dependents); throws on cycles. */
export function derivationOrder(fields: readonly FieldDefinition[]): FieldDefinition[] {
  const cycle = findDerivationCycle(fields);
  if (cycle) throw new Error(`Derivation cycle: ${cycle.join(' → ')}`);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const ordered: FieldDefinition[] = [];
  const seen = new Set<string>();
  const visit = (f: FieldDefinition) => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    const from = f.kind === 'date' ? f.config.tracking?.derive?.from : undefined;
    const dep = from ? byKey.get(from) : undefined;
    if (dep) visit(dep);
    ordered.push(f);
  };
  fields.forEach(visit);
  return ordered;
}

function findDerivationCycle(fields: readonly FieldDefinition[]): string[] | null {
  const deps = new Map<string, string>();
  for (const f of fields) {
    const from = f.kind === 'date' ? f.config.tracking?.derive?.from : undefined;
    if (from) deps.set(f.key, from);
  }
  for (const start of deps.keys()) {
    const path = [start];
    let cur = deps.get(start);
    while (cur) {
      if (cur === start) return [...path, cur];
      if (path.includes(cur)) break;
      path.push(cur);
      cur = deps.get(cur);
    }
  }
  return null;
}
