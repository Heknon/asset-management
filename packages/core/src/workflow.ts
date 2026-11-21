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

// ─── Added workflows ───────────────────────────────────────────────────────

/**
 * Workflows extend the way fields do: the purchase workflow (organization
 * default, or the template's own) is always there, and a template or a team
 * variant can add more, each with a name and a unit responsible for it:
 *
 *   Software license (template)  · Purchase            → Procurement
 *   Lab license (R&D's variant)  · Machine status      → R&D Lab      (on the item)
 *                                · Swap the new key   → R&D Lab      (on the request, after the purchase is done)
 *
 * Item workflows track a lasting state of the item (a machine: Not deployed →
 * Installing → Running → Retired). Request workflows are steps of one
 * purchase or renewal, run alongside the buying or starting once it is done.
 * Everyone who can see the item or request sees every workflow's status; only
 * the responsible unit (its members, and people who manage it) moves it.
 * An added workflow never changes how the purchase workflow runs.
 */
export const workflowTargets = ['item', 'request'] as const;
export type WorkflowTarget = (typeof workflowTargets)[number];

export const extraWorkflowSchema = z.object({
  /** Unique across the template and its variants (items and requests store their state under it). */
  key: fieldKeySchema,
  name: z.string().trim().min(1).max(60),
  appliesTo: z.enum(workflowTargets),
  /** The unit responsible for moving it; null: the item's own unit (the team that uses it). */
  responsibleUnitId: z.string().uuid().nullable().default(null),
  /** Request workflows: 'created' runs alongside the purchase, 'purchase_done' starts when it is done. Item workflows start with the item. */
  startsWhen: z.enum(['created', 'purchase_done']).default('created'),
  statuses: z.array(workflowStatusSchema).min(2).max(20),
  transitions: z.array(workflowTransitionSchema).max(300),
});
export type ExtraWorkflow = z.infer<typeof extraWorkflowSchema>;

/** Ready-made workflows to start from. */
export const workflowPresets: Record<'machines' | 'swap', Omit<ExtraWorkflow, 'key' | 'responsibleUnitId'>> = {
  machines: {
    name: 'Machine status',
    appliesTo: 'item',
    startsWhen: 'created',
    statuses: [
      { key: 'not_deployed', label: 'Not deployed', color: '#6366f1', category: 'todo' },
      { key: 'installing', label: 'Installing', color: '#f59e0b', category: 'active' },
      { key: 'running', label: 'Running', color: '#10b981', category: 'done' },
      { key: 'retired', label: 'Retired', color: '#94a3b8', category: 'closed' },
    ],
    transitions: [t('not_deployed', 'installing'), t('installing', 'running'), t('installing', 'not_deployed'), t('running', 'installing'), t('running', 'retired'), t('retired', 'installing')],
  },
  swap: {
    name: 'Swap the new license',
    appliesTo: 'request',
    startsWhen: 'purchase_done',
    statuses: [
      { key: 'to_install', label: 'To install', color: '#6366f1', category: 'todo' },
      { key: 'swapping', label: 'Swapping on machines', color: '#f59e0b', category: 'active' },
      { key: 'installed', label: 'Installed', color: '#10b981', category: 'done' },
      { key: 'not_needed', label: 'Not needed', color: '#94a3b8', category: 'closed' },
    ],
    transitions: [t('to_install', 'swapping'), t('to_install', 'installed'), t('to_install', 'not_needed'), t('swapping', 'installed'), t('swapping', 'to_install')],
  },
};

/**
 * An added workflow starts at a to-do status and can reach Done. Closed is
 * optional; item workflows may move out of Done again (Running → Installing).
 */
export function validateExtraWorkflow(wf: ExtraWorkflow): SchemaIssueLite[] {
  const issues = validateWorkflow(wf).filter((i) => !/“Closed” status/.test(i.message));
  if (wf.appliesTo === 'item' && wf.startsWhen !== 'created') issues.push({ path: 'startsWhen', message: 'Item workflows start when the item is added' });
  return issues.map((i) => ({ ...i, message: i.message.replace('(where requests start)', '(where it starts)').replace(', for when the item is bought or renewed', '') }));
}

/** Keys must be unique, and must not clash with the ones already above (the template's, for a variant). */
export function validateExtraWorkflows(list: ExtraWorkflow[], takenKeys: ReadonlySet<string> = new Set(), path = 'workflows'): SchemaIssueLite[] {
  const issues: SchemaIssueLite[] = [];
  const keys = new Set<string>();
  list.forEach((wf, i) => {
    if (keys.has(wf.key)) issues.push({ path: `${path}.${i}.key`, message: `Two workflows are called "${wf.key}"` });
    if (takenKeys.has(wf.key)) issues.push({ path: `${path}.${i}.key`, message: `The template already has a workflow "${wf.key}"` });
    keys.add(wf.key);
    for (const x of validateExtraWorkflow(wf)) issues.push({ path: `${path}.${i}.${x.path}`, message: `${wf.name}: ${x.message}` });
  });
  return issues;
}

/** Where one workflow of an item or request stands. Stored per workflow key. */
export interface WorkflowStateValue {
  status: string;
  category: StatusCategory;
  /** The responsible unit when it started (lists of "what is waiting on my unit" use it). */
  unitId: string;
  at: string;
}
export type WorkflowStates = Record<string, WorkflowStateValue>;

/**
 * One status for everything together: closed if the purchase was called off;
 * otherwise open while any workflow is (waiting on whoever owns it), done
 * when every started one is done or closed. `waitingOn` lists the open ones,
 * so a request reads "Done for Procurement · Lab: Swapping on machines".
 */
export function combineStatuses(parts: Array<{ key: string; category: StatusCategory; started: boolean }>): { category: StatusCategory; waitingOn: string[] } {
  const purchase = parts[0];
  if (purchase?.category === 'closed') return { category: 'closed', waitingOn: [] };
  const open = parts.filter((p) => p.started && isOpenCategory(p.category));
  if (!open.length) return { category: 'done', waitingOn: [] };
  return { category: open.every((p) => p.category === 'todo') ? 'todo' : 'active', waitingOn: open.map((p) => p.key) };
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
