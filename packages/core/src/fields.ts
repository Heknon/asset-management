import { z } from 'zod';
import { durationSchema, durationUnits } from './duration.js';

export const fieldKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores, starting with a letter');

const optionSchema = z.object({
  value: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type SelectOption = z.infer<typeof optionSchema>;

/**
 * How a date field is computed from other fields instead of being typed in,
 * e.g. "Notice deadline = Renewal date − notice period (days)".
 */
export const dateDerivationSchema = z.object({
  from: fieldKeySchema,
  direction: z.enum(['before', 'after']),
  /** Either a fixed amount or the value of a number field on the same asset. */
  amount: z.union([z.object({ fixed: z.number().int().min(0) }), z.object({ field: fieldKeySchema })]),
  unit: z.enum(durationUnits),
});
export type DateDerivation = z.infer<typeof dateDerivationSchema>;

/** Overrides the date kind's recurrence for this field. */
export const recurrenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), every: durationSchema }),
  /** Interval read from a number field, e.g. "Term (months)". */
  z.object({ mode: z.literal('field'), field: fieldKeySchema, unit: z.enum(durationUnits) }),
  /** No fixed term: each renewal says the new date ("bought a year, got a year and 10 days"). */
  z.object({ mode: z.literal('manual') }),
]);
export type Recurrence = z.infer<typeof recurrenceSchema>;

/** Who is notified about a tracked date. */
export const notifyRuleSchema = z.object({
  owner: z.boolean().default(true),
  /** Keys of `user` fields whose people are notified (e.g. "technical_contact"). */
  userFields: z.array(fieldKeySchema).default([]),
  /** Extra addresses such as a shared procurement mailbox. */
  emails: z.array(z.string().email()).default([]),
  /**
   * Managers of the asset's unit (nearest unit up the tree that has managers):
   * `fallback` = only when nobody else would be notified (e.g. the owner left).
   */
  unitManagers: z.enum(['never', 'fallback', 'always']).default('fallback'),
});
export type NotifyRule = z.infer<typeof notifyRuleSchema>;

export const dateTrackingSchema = z.object({
  dateKindId: z.string().uuid(),
  /**
   * How this date comes back, when not as its kind usually does: `recurring`
   * (renewed: on a schedule, or to a date given each time), `milestone` (once,
   * then done) or `informational` (no reminders). What the date *is* (its
   * kind) and how it behaves are separate choices.
   */
  behavior: z.enum(['milestone', 'recurring', 'informational']).optional(),
  derive: dateDerivationSchema.optional(),
  recurrence: recurrenceSchema.optional(),
  reminders: z.array(durationSchema).max(10).optional(),
  notify: notifyRuleSchema.default({}),
  /** Recurring dates: ask the owner "still needed?" this long before (null: only when someone asks). */
  confirmBefore: durationSchema.nullable().default(null),
});
export type DateTracking = z.infer<typeof dateTrackingSchema>;

const base = {
  id: z.string().uuid(),
  key: fieldKeySchema,
  label: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  required: z.boolean().default(false),
  /** Restricted fields are only visible to and editable by people with the "See secrets" permission. */
  restricted: z.boolean().default(false),
  /**
   * Restricted fields (and secrets): the item's owner sees it too, not only
   * people with "See secrets". The admin password stays with the buyers; the
   * license key is also for whoever holds the item.
   */
  ownerCanSee: z.boolean().optional(),
  section: z.string().max(60).optional(),
  /** Shown as a column in the asset table by default. */
  showInTable: z.boolean().default(false),
};

export const fieldDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('text'), config: z.object({ maxLength: z.number().int().positive().optional(), pattern: z.string().optional(), placeholder: z.string().optional() }).default({}) }),
  z.object({ ...base, kind: z.literal('longText'), config: z.object({ maxLength: z.number().int().positive().optional() }).default({}) }),
  z.object({ ...base, kind: z.literal('number'), config: z.object({ min: z.number().optional(), max: z.number().optional(), integer: z.boolean().default(false), unit: z.string().max(16).optional() }).default({}) }),
  z.object({
    ...base,
    kind: z.literal('currency'),
    config: z
      .object({
        currency: z.string().length(3).default('USD'),
        /** Counted in spend totals (e.g. "renewing in the next 90 days"). */
        countsTowardSpend: z.boolean().default(false),
      })
      .default({}),
  }),
  z.object({ ...base, kind: z.literal('date'), config: z.object({ tracking: dateTrackingSchema.optional() }).default({}) }),
  z.object({ ...base, kind: z.literal('boolean'), config: z.object({}).default({}) }),
  z.object({ ...base, kind: z.literal('select'), config: z.object({ options: z.array(optionSchema).min(1) }) }),
  z.object({ ...base, kind: z.literal('multiSelect'), config: z.object({ options: z.array(optionSchema).min(1) }) }),
  z.object({ ...base, kind: z.literal('user'), config: z.object({}).default({}) }),
  z.object({ ...base, kind: z.literal('url'), config: z.object({}).default({}) }),
  z.object({ ...base, kind: z.literal('email'), config: z.object({}).default({}) }),
  z.object({ ...base, kind: z.literal('secret'), config: z.object({}).default({}) }),
  z.object({
    ...base,
    kind: z.literal('assetRef'),
    config: z
      .object({
        assetTypeId: z.string().uuid().optional(),
        /** Several linked items (e.g. the machines that use a license). */
        multiple: z.boolean().default(false),
      })
      .default({}),
  }),
  /**
   * A sign-in: the address, the user name and the password (or key, or token)
   * that go together. The address and user name are like any field; the
   * password is a secret: stored apart, shown only to people who may see
   * secrets (or the owner, when the field allows it), never searched.
   */
  z.object({
    ...base,
    kind: z.literal('login'),
    config: z.object({ secretLabel: z.enum(['password', 'key', 'token']).default('password') }).default({}),
  }),
  z.object({
    ...base,
    kind: z.literal('list'),
    config: z
      .object({
        /** Every entry must match, e.g. a MAC address. */
        pattern: z.string().max(400).optional(),
        placeholder: z.string().max(80).optional(),
        maxItems: z.number().int().positive().max(1000).default(200),
      })
      .default({}),
  }),
]);
export type FieldDefinition = z.infer<typeof fieldDefinitionSchema>;
export type FieldKind = FieldDefinition['kind'];
export type FieldOf<K extends FieldKind> = Extract<FieldDefinition, { kind: K }>;

export const fieldKinds = fieldDefinitionSchema.options.map((o) => o.shape.kind.value) as FieldKind[];

/** Display metadata for the field-type picker. */
export const fieldKindMeta: Record<FieldKind, { label: string; description: string }> = {
  text: { label: 'Text', description: 'Single line of text' },
  longText: { label: 'Long text', description: 'Paragraphs, notes' },
  number: { label: 'Number', description: 'Quantities, seats, terms' },
  currency: { label: 'Currency', description: 'Costs and prices' },
  date: { label: 'Date', description: 'Optionally tracked with reminders' },
  boolean: { label: 'Checkbox', description: 'Yes / no' },
  select: { label: 'Single select', description: 'One option from a list' },
  multiSelect: { label: 'Multi select', description: 'Several options from a list' },
  user: { label: 'Person', description: 'A user in the directory' },
  url: { label: 'URL', description: 'Web link' },
  email: { label: 'Email', description: 'Email address' },
  secret: { label: 'Secret', description: 'License keys, PINs — always restricted' },
  assetRef: { label: 'Linked asset', description: 'Reference another asset, or several' },
  list: { label: 'List', description: 'Several short values: MAC addresses, hostnames, serials' },
  login: { label: 'Login', description: 'Address, user name and password together' },
};

/** Secrets are always restricted, regardless of the flag. */
export function isRestricted(field: FieldDefinition): boolean {
  return field.restricted || field.kind === 'secret';
}

/** A login's password (key, token): who may see it, when the login itself is visible. */
export function canSeeLoginSecret(field: FieldDefinition, who: { canSeeRestricted: boolean; isOwner: boolean }): boolean {
  return who.canSeeRestricted || (who.isOwner && !!field.ownerCanSee);
}

/** Whether this person may see a field's value: anyone for open fields; for restricted ones, "See secrets", or the owner when the field allows it. */
export function canSeeField(field: FieldDefinition, who: { canSeeRestricted: boolean; isOwner: boolean }): boolean {
  return !isRestricted(field) || who.canSeeRestricted || (who.isOwner && !!field.ownerCanSee);
}

export function isDerivedDate(field: FieldDefinition): field is FieldOf<'date'> & { config: { tracking: DateTracking & { derive: DateDerivation } } } {
  return field.kind === 'date' && !!field.config.tracking?.derive;
}
