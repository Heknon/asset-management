/**
 * Request workflows, Jira-style: statuses (each in a category) and the moves
 * between them. The organization has a default; any template can have its
 * own ("Hardware": Requested → Approved → Ordered → Delivered). Purchases and
 * renewals of that template follow it.
 *
 * Categories carry the meaning, so lists, counts and automation work for any
 * workflow:
 *   todo    waiting to be looked at (the first status is where requests start)
 *   active  being worked on
 *   done    finished: a purchase got its item, a renewal rolled its date forward
 *   closed  will not happen (rejected, cancelled)
 */
import { z } from 'zod';
import { fieldKeySchema } from './fields.js';

export const statusCategories = ['todo', 'active', 'done', 'closed'] as const;
export type StatusCategory = (typeof statusCategories)[number];

export const statusCategoryMeta: Record<StatusCategory, { label: string; description: string }> = {
  todo: { label: 'To do', description: 'Waiting to be picked up' },
  active: { label: 'In progress', description: 'Someone is working on it' },
  done: { label: 'Done', description: 'Bought, delivered or renewed' },
  closed: { label: 'Closed', description: 'Will not happen' },
};

export const workflowStatusSchema = z.object({
  key: fieldKeySchema,
  label: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  category: z.enum(statusCategories),
});
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/** Who may make a move: people who handle the requests, or (also) the person who asked. */
export const workflowTransitionSchema = z.object({ from: fieldKeySchema, to: fieldKeySchema, by: z.enum(['handler', 'requester']) });
export type WorkflowTransition = z.infer<typeof workflowTransitionSchema>;

export const workflowSchema = z.object({
  statuses: z.array(workflowStatusSchema).min(3).max(20),
  transitions: z.array(workflowTransitionSchema).max(300),
});
export type Workflow = z.infer<typeof workflowSchema>;

const t = (from: string, to: string, by: 'handler' | 'requester' = 'handler'): WorkflowTransition => ({ from, to, by });

/** The workflow requests have always had; the organization default until someone changes it. */
export const defaultWorkflow: Workflow = {
  statuses: [
    { key: 'submitted', label: 'Submitted', color: '#6366f1', category: 'todo' },
    { key: 'in_review', label: 'In review', color: '#f59e0b', category: 'active' },
    { key: 'approved', label: 'Approved', color: '#10b981', category: 'active' },
    { key: 'ordered', label: 'Ordered', color: '#0ea5e9', category: 'active' },
    { key: 'fulfilled', label: 'Fulfilled', color: '#10b981', category: 'done' },
    { key: 'rejected', label: 'Declined', color: '#e11d48', category: 'closed' },
    { key: 'cancelled', label: 'Cancelled', color: '#94a3b8', category: 'closed' },
  ],
  transitions: [
    t('submitted', 'in_review'),
    t('submitted', 'approved'),
    t('submitted', 'rejected'),
    t('submitted', 'cancelled', 'requester'),
    t('in_review', 'approved'),
    t('in_review', 'rejected'),
    t('in_review', 'submitted'),
    t('in_review', 'cancelled', 'requester'),
    t('approved', 'ordered'),
    t('approved', 'fulfilled'),
    t('approved', 'rejected'),
    t('approved', 'cancelled', 'requester'),
    t('ordered', 'approved'),
    t('ordered', 'fulfilled'),
    t('rejected', 'in_review'),
  ],
};

export interface SchemaIssueLite {
  path: string;
  message: string;
}

/** A workflow must start at a to-do status, be able to finish and to close, and only reference its own statuses. */
export function validateWorkflow(wf: Workflow): SchemaIssueLite[] {
  const issues: SchemaIssueLite[] = [];
  const keys = new Set<string>();
  wf.statuses.forEach((s, i) => {
    if (keys.has(s.key)) issues.push({ path: `statuses.${i}.key`, message: `Two statuses are called "${s.key}"` });
    keys.add(s.key);
  });
  if (wf.statuses[0]?.category !== 'todo') issues.push({ path: 'statuses.0', message: 'The first status (where requests start) must be a “To do” status' });
  if (!wf.statuses.some((s) => s.category === 'done')) issues.push({ path: 'statuses', message: 'Add a “Done” status, for when the item is bought or renewed' });
  if (!wf.statuses.some((s) => s.category === 'closed')) issues.push({ path: 'statuses', message: 'Add a “Closed” status, for requests that will not happen' });
  wf.transitions.forEach((x, i) => {
    if (!keys.has(x.from) || !keys.has(x.to)) issues.push({ path: `transitions.${i}`, message: 'A move refers to a status that does not exist' });
    if (x.from === x.to) issues.push({ path: `transitions.${i}`, message: 'A status cannot move to itself' });
  });
  // Every request must be able to reach Done from where it starts.
  const reach = new Set([wf.statuses[0]?.key]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of wf.transitions) if (reach.has(x.from) && !reach.has(x.to)) (reach.add(x.to), (grew = true));
  }
  if (wf.statuses.length && !wf.statuses.some((s) => s.category === 'done' && reach.has(s.key))) issues.push({ path: 'transitions', message: 'No path leads from the first status to a “Done” status' });
  return issues;
}

// ─── A team's own steps after the buyers are done ─────────────────────────

/**
 * What a unit does once the buyers finish ("our part"): procurement renewed
 * the license, but for the team that uses it the work starts now: install the
 * new key, swap it on every machine, renew the machines. Set on a team
 * variant, so it applies to that unit's items of that kind; the request then
 * has two statuses: the buyers' and the team's.
 *
 * Same shape as a request workflow; it starts at its first (to-do) status
 * when the buying is done, and must be able to reach Done. Closed is optional
 * ("not needed after all").
 */
export const followUpSchema = z.object({
  statuses: z.array(workflowStatusSchema).min(2).max(20),
  transitions: z.array(workflowTransitionSchema).max(300),
});

/** A ready-made follow-up: the new license has to be installed where the old one was. */
export const defaultFollowUp: Workflow = {
  statuses: [
    { key: 'to_install', label: 'To install', color: '#6366f1', category: 'todo' },
    { key: 'installing', label: 'Swapping on machines', color: '#f59e0b', category: 'active' },
    { key: 'installed', label: 'Installed', color: '#10b981', category: 'done' },
    { key: 'not_needed', label: 'Not needed', color: '#94a3b8', category: 'closed' },
  ],
  transitions: [t('to_install', 'installing'), t('to_install', 'installed'), t('to_install', 'not_needed'), t('installing', 'installed'), t('installing', 'to_install')],
};

/** Like a request workflow, without having to be closable. */
export function validateFollowUp(wf: Workflow): SchemaIssueLite[] {
  return validateWorkflow(wf)
    .filter((i) => !/“Closed” status/.test(i.message))
    .map((i) => (/“Done” status, for when/.test(i.message) ? { ...i, message: 'Add a “Done” status, for when your part is finished' } : /first status \(where requests start\)/.test(i.message) ? { ...i, message: 'The first status (where your part starts) must be a “To do” status' } : i));
}

const unknownStatus = (key: string): WorkflowStatus => ({ key, label: key.replace(/_/g, ' '), color: '#94a3b8', category: 'active' });

export const statusIn = (wf: Workflow, key: string): WorkflowStatus => wf.statuses.find((s) => s.key === key) ?? unknownStatus(key);
export const initialStatus = (wf: Workflow): WorkflowStatus => wf.statuses[0]!;
export const firstOfCategory = (wf: Workflow, c: StatusCategory): WorkflowStatus | undefined => wf.statuses.find((s) => s.category === c);
export const isOpenCategory = (c: StatusCategory) => c === 'todo' || c === 'active';

/** Moves this person may make from `from` (handlers make every move; requesters only theirs). */
export function allowedMoves(wf: Workflow, from: string, actor: { isHandler: boolean; isRequester: boolean }): WorkflowStatus[] {
  const out: WorkflowStatus[] = [];
  for (const x of wf.transitions) {
    if (x.from !== from) continue;
    if (x.by === 'handler' && !actor.isHandler) continue;
    if (x.by === 'requester' && !actor.isRequester && !actor.isHandler) continue;
    const s = wf.statuses.find((y) => y.key === x.to);
    if (s && !out.some((o) => o.key === s.key)) out.push(s);
  }
  return out;
}
