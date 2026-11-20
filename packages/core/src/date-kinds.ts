import { z } from 'zod';
import { durationSchema } from './duration.js';

/**
 * A date kind gives a date field its *meaning*. Kinds are an admin-managed
 * catalogue (Renewal, Expiry, Warranty end, Payment due, Notice deadline, ...),
 * not a hard-coded enum, so any template can say what its dates are for.
 *
 * - `milestone`: happens once; completing it closes the obligation.
 * - `recurring`: completing it rolls the date forward by the recurrence interval.
 * - `informational`: shown on timelines/calendars but never reminds.
 */
export const dateBehaviors = ['milestone', 'recurring', 'informational'] as const;
export type DateBehavior = (typeof dateBehaviors)[number];

export const dateKindInputSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  behavior: z.enum(dateBehaviors),
  /** Verb used for the primary action in the UI and in notifications ("Renew", "Replace", "Pay"). */
  actionLabel: z.string().min(1).max(32).default('Complete'),
  /** Default interval for recurring kinds; a field can override it. */
  defaultRecurrence: durationSchema.optional(),
  /** Default reminder offsets *before* the date; a field or a single asset can override them. */
  defaultReminders: z.array(durationSchema).max(10).default([]),
});
export type DateKindInput = z.infer<typeof dateKindInputSchema>;

export const dateKindSchema = dateKindInputSchema.extend({
  id: z.string().uuid(),
  archived: z.boolean().default(false),
});
export type DateKind = z.infer<typeof dateKindSchema>;

/** Seed catalogue; administrators can edit, archive or add to it. */
export const defaultDateKinds: DateKindInput[] = [
  {
    key: 'renewal',
    name: 'Renewal',
    color: '#6366f1',
    behavior: 'recurring',
    actionLabel: 'Renew',
    defaultRecurrence: { amount: 1, unit: 'year' },
    defaultReminders: [
      { amount: 90, unit: 'day' },
      { amount: 60, unit: 'day' },
      { amount: 30, unit: 'day' },
      { amount: 7, unit: 'day' },
    ],
  },
  {
    key: 'notice_deadline',
    name: 'Notice deadline',
    description: 'Last day to cancel or renegotiate before an automatic renewal.',
    color: '#f43f5e',
    behavior: 'milestone',
    actionLabel: 'Decide',
    defaultReminders: [
      { amount: 30, unit: 'day' },
      { amount: 14, unit: 'day' },
      { amount: 3, unit: 'day' },
    ],
  },
  {
    key: 'expiry',
    name: 'Expiry',
    color: '#f59e0b',
    behavior: 'milestone',
    actionLabel: 'Replace',
    defaultReminders: [
      { amount: 30, unit: 'day' },
      { amount: 7, unit: 'day' },
    ],
  },
  {
    key: 'payment_due',
    name: 'Payment due',
    color: '#10b981',
    behavior: 'recurring',
    actionLabel: 'Mark paid',
    defaultRecurrence: { amount: 1, unit: 'month' },
    defaultReminders: [{ amount: 5, unit: 'day' }],
  },
  {
    key: 'warranty_end',
    name: 'Warranty end',
    color: '#0ea5e9',
    behavior: 'milestone',
    actionLabel: 'Acknowledge',
    defaultReminders: [{ amount: 30, unit: 'day' }],
  },
  { key: 'start', name: 'Start / purchase', color: '#64748b', behavior: 'informational', actionLabel: 'Complete', defaultReminders: [] },
];
