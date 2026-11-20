import { z } from 'zod';
import { fieldDefinitionSchema, fieldKeySchema, type FieldDefinition } from './fields.js';
import { workflowSchema } from './workflow.js';

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
  /** Purchases and renewals of this template follow this workflow (null: the organization's default). */
  requestWorkflow: workflowSchema.nullable().optional(),
  /** Item IDs are PREFIX-number ("LIC-42"); defaults from the key. */
  refPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{0,5}$/, 'Letters and digits, starting with a letter, up to 6')
    .optional(),
});
export type AssetTypeInput = z.infer<typeof assetTypeInputSchema>;

/** "software_license" → "SL", "hardware" → "HAR"; used when a template has no prefix. */
export function defaultRefPrefix(key: string): string {
  const words = key.split(/[_\W]+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'ITEM').slice(0, 3);
  return (p.replace(/[^a-z0-9]/gi, '').toUpperCase() || 'ITEM').replace(/^[0-9]/, 'X').slice(0, 6);
}

export const formatReference = (prefix: string, n: number) => `${prefix}-${n}`;

export const assetTypeSchema = assetTypeInputSchema.extend({
  refPrefix: z.string(),
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

// ─── Team variants ─────────────────────────────────────────────────────────

/**
 * A unit's extension of an organization template: same template, plus the
 * fields that unit needs ("Design license" = Software license + Workstation,
 * MAC addresses). Available to the unit and everything beneath it; changes to
 * the template flow into every variant.
 */
export const typeVariantInputSchema = z.object({
  unitId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(400).nullable().default(null),
  sections: z.array(z.string().min(1).max(60)).max(20).default([]),
  fields: z.array(fieldDefinitionSchema).max(100),
});
export type TypeVariantInput = z.infer<typeof typeVariantInputSchema>;

export interface TypeVariant extends TypeVariantInput {
  id: string;
  assetTypeId: string;
  version: number;
  archived: boolean;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/** The schema an item of a variant follows: the template's fields, then the variant's. */
export function withVariant<T extends Pick<AssetType, 'fields' | 'sections'>>(type: T, variant: Pick<TypeVariant, 'fields' | 'sections'> | null | undefined): T {
  if (!variant) return type;
  return { ...type, fields: [...type.fields, ...variant.fields], sections: [...type.sections, ...variant.sections.filter((x) => !type.sections.includes(x))] };
}

/** A variant must not redefine template fields; the combined schema must be valid. */
export function validateVariantStructure(type: Pick<AssetType, 'fields' | 'sections' | 'statuses' | 'key' | 'name'>, input: TypeVariantInput, knownDateKindIds: ReadonlySet<string>): SchemaIssue[] {
  const baseKeys = new Set(type.fields.map((f) => f.key));
  const issues: SchemaIssue[] = [];
  input.fields.forEach((f, i) => {
    if (baseKeys.has(f.key)) issues.push({ path: `fields.${i}.key`, message: `“${type.name}” already has a field "${f.key}"` });
  });
  const merged = validateTypeStructure(
    { key: type.key, name: type.name, icon: 'box', color: '#000000', statuses: type.statuses, sections: [...type.sections, ...input.sections], fields: [...type.fields, ...input.fields] },
    knownDateKindIds,
  );
  const offset = type.fields.length;
  for (const m of merged) {
    const match = /^fields\.(\d+)(.*)$/.exec(m.path);
    if (match && Number(match[1]) >= offset) issues.push({ path: `fields.${Number(match[1]) - offset}${match[2]}`, message: m.message });
    else if (!match && !issues.some((x) => x.message === m.message)) issues.push(m);
  }
  return issues;
}
