import {
  allowedMoves,
  defaultWorkflow,
  firstOfCategory,
  initialStatus,
  isOpenCategory,
  statusIn,
  unitPermissions,
  workflowSchema,
  workflowsOf,
  type ExtraWorkflow,
  type Principal,
  type RequestChanged,
  type RequestStatusInfo,
  type StatusCategory,
  type Workflow,
  type WorkflowOrigin,
  type WorkflowStates,
  type WorkflowStateValue,
  type WorkflowView,
} from '@am/core';
import { requestNumber, type RequestState } from '../domain/request.js';
import type { RegistryStore } from './ports.js';

export const DEFAULT_WORKFLOW_KEY = 'request_workflow';

/** The organization's default request workflow (as last saved, or the built-in one). */
export async function organizationWorkflow(store: RegistryStore): Promise<Workflow> {
  const saved = await store.getSetting<unknown>(DEFAULT_WORKFLOW_KEY);
  const parsed = saved ? workflowSchema.safeParse(saved) : null;
  return parsed?.success ? parsed.data : defaultWorkflow;
}

/** The workflow requests for a template follow: its own, or the organization's. */
export async function workflowFor(store: RegistryStore, assetTypeId: string | null): Promise<Workflow> {
  const type = assetTypeId ? await store.getType(assetTypeId) : null;
  return type?.requestWorkflow ?? (await organizationWorkflow(store));
}

export function requestChangedEvent(
  r: RequestState,
  wf: Workflow,
  actor: { id: string; name: string },
  kind: RequestChanged['kind'],
  previousStatus: string | null,
  note: string | null,
  extra: { workflow?: { def: ExtraWorkflow; state: WorkflowStateValue }; waitingOn?: RequestChanged['waitingOn'] } = {},
): RequestChanged {
  const own = extra.workflow;
  const s = own
    ? { ...statusIn(own.def, own.state.status), category: own.state.category }
    : (wf.statuses.find((x) => x.key === r.status) ?? { ...statusIn(wf, r.status), category: r.statusCategory });
  return {
    requestId: r.id,
    number: requestNumber(r.seq),
    title: r.title,
    unitId: r.unitId,
    requesterId: r.requesterId,
    assigneeId: r.assigneeId,
    status: own ? own.state.status : r.status,
    statusLabel: s.label,
    statusColor: s.color,
    statusCategory: s.category,
    previousStatus,
    actorId: actor.id,
    actorName: actor.name,
    note,
    kind,
    requestKind: r.kind,
    renewal: r.renewal,
    workflow: own ? { key: own.def.key, name: own.def.name, responsibleUnitId: own.state.unitId } : null,
    ...(extra.waitingOn && { waitingOn: extra.waitingOn }),
    at: new Date().toISOString(),
  };
}

/** Publishes a change, telling who the request still waits on. */
export async function publishRequestChange(
  tx: RegistryStore,
  r: RequestState,
  wf: Workflow,
  actor: { id: string; name: string },
  kind: RequestChanged['kind'],
  previousStatus: string | null,
  note: string | null,
  workflow?: { def: ExtraWorkflow; state: WorkflowStateValue },
): Promise<void> {
  const defs = await requestWorkflowDefs(tx, r);
  await tx.publish('request.changed', requestChangedEvent(r, wf, actor, kind, previousStatus, note, { workflow, waitingOn: waitingOn(defs, r.workflowStates) }));
}

/** The purchase is done (bought, or renewed): workflows waiting for it start, and everyone hears. */
export async function finishPurchase(
  tx: RegistryStore,
  r: RequestState,
  wf: Workflow,
  done: { key: string; category: StatusCategory },
  actor: { id: string; name: string },
  event: { body: string | null; note: string | null; assetId?: string; variantId?: string | null },
): Promise<void> {
  await tx.setRequestStatus(r.id, done, event.assetId);
  if (event.variantId !== undefined && event.variantId !== r.workflowVariantId) {
    await switchRequestVariant(tx, r, event.variantId);
    // The new team's workflows that run alongside the purchase start too (they never had the chance).
    await startRequestWorkflows(tx, r, 'created', actor);
  }
  await tx.addRequestEvent({ requestId: r.id, actorId: actor.id, actorName: actor.name, kind: 'fulfilled', body: event.body, fromStatus: r.status, toStatus: done.key });
  const next = { ...r, status: done.key, statusCategory: done.category };
  await startRequestWorkflows(tx, next, 'purchase_done', actor);
  await publishRequestChange(tx, next, wf, actor, 'fulfilled', r.status, event.note);
}

/** A request now follows another team's fields: their workflows, without the old team's. */
export async function switchRequestVariant(tx: RegistryStore, r: RequestState, variantId: string | null): Promise<void> {
  await tx.setRequestWorkflowVariant(r.id, variantId);
  r.workflowVariantId = variantId;
  const keys = (await requestWorkflowDefs(tx, r)).map((d) => d.key);
  await tx.keepRequestWorkflows(r.id, keys);
  r.workflowStates = Object.fromEntries(Object.entries(r.workflowStates).filter(([k]) => keys.includes(k)));
}

/**
 * Renewing a date directly ("Renew" on the item) finishes the renewal
 * requests that were open for it, so the two never disagree.
 */
export async function completeRenewals(tx: RegistryStore, assetId: string, fieldKey: string, actor: { id: string; name: string }, skipRequestId?: string): Promise<void> {
  for (const r of await tx.openRenewals(assetId, fieldKey)) {
    if (r.id === skipRequestId) continue;
    const wf = await workflowFor(tx, r.assetTypeId);
    await finishPurchase(tx, r, wf, firstOfCategory(wf, 'done')!, actor, { body: 'Renewed on the item', note: null });
  }
}

// ─── Added workflows ───────────────────────────────────────────────────────

export const PURCHASE_UNIT_KEY = 'purchase_unit_id';

/** The unit responsible for purchases (Settings → Request workflow), if one is set. */
export async function purchaseUnit(store: RegistryStore): Promise<string | null> {
  const v = await store.getSetting<unknown>(PURCHASE_UNIT_KEY);
  return typeof v === 'string' ? v : null;
}

/**
 * Who may move a workflow: members of its responsible unit or of a unit
 * beneath it, and people who manage it (its managers, admins). Someone who
 * can merely edit there (Procurement edits everything) does not move the
 * Lab's workflows. Caches unit paths for one call.
 */
export class Responsibility {
  private mine?: Promise<Map<string, string[]>>;
  private readonly paths = new Map<string, Promise<string[]>>();
  constructor(
    private readonly store: RegistryStore,
    private readonly p: Principal,
  ) {}

  private pathOf(unitId: string) {
    if (!this.paths.has(unitId)) this.paths.set(unitId, this.store.getUnit(unitId).then((u) => u?.path ?? [unitId]));
    return this.paths.get(unitId)!;
  }

  async canAct(unitId: string | null): Promise<boolean> {
    if (!unitId) return false;
    if (this.p.isAdmin) return true;
    this.mine ??= this.store.unitPaths(this.p.units.map((u) => u.unitId));
    const mine = await this.mine;
    if (this.p.units.some((u) => (mine.get(u.unitId) ?? [u.unitId]).includes(unitId))) return true;
    return unitPermissions(this.p, await this.pathOf(unitId)).has('manage');
  }
}

const info = (s: { key: string; label: string; color: string; category: StatusCategory }): RequestStatusInfo => ({ key: s.key, label: s.label, color: s.color, category: s.category });

/** One added workflow as an item or request shows it. A missing state means not started (requests) or at the first status (items). */
export function workflowView(
  def: ExtraWorkflow & { origin: WorkflowOrigin },
  state: WorkflowStateValue | undefined,
  ctx: { ownUnitId: string; canAct: boolean; isRequester: boolean; open: boolean },
): WorkflowView {
  const current = state ? statusIn(def, state.status) : def.appliesTo === 'item' ? initialStatus(def) : null;
  const shown = current && state && !def.statuses.some((s) => s.key === state.status) ? { ...current, category: state.category } : current;
  const moves = current && ctx.open ? allowedMoves(def, current.key, { isHandler: ctx.canAct, isRequester: ctx.isRequester }) : [];
  return {
    key: def.key,
    name: def.name,
    origin: def.origin.kind,
    appliesTo: def.appliesTo,
    responsibleUnitId: state?.unitId ?? def.responsibleUnitId ?? ctx.ownUnitId,
    started: !!shown,
    statusInfo: shown ? info(shown) : null,
    statuses: def.statuses.map(info),
    moves: moves.map(info),
    canAct: ctx.canAct,
  };
}

/** The request's own added workflows: the template's, and those of the team variant it follows. */
export async function requestWorkflowDefs(store: RegistryStore, r: Pick<RequestState, 'assetTypeId' | 'workflowVariantId'>) {
  const type = r.assetTypeId ? await store.getType(r.assetTypeId) : null;
  if (!type) return [];
  const variant = r.workflowVariantId ? await store.getVariant(r.workflowVariantId) : null;
  return workflowsOf(type, variant, 'request');
}

/**
 * Starts the request's added workflows that begin now: with the request
 * ('created'), or once the purchase is done ('purchase_done'). Each starts at
 * its first status, responsible unit fixed at that moment.
 */
export async function startRequestWorkflows(tx: RegistryStore, r: RequestState, when: 'created' | 'purchase_done', actor: { id: string; name: string }): Promise<void> {
  const defs = await requestWorkflowDefs(tx, r);
  for (const def of defs) {
    if (def.startsWhen !== when || r.workflowStates[def.key]) continue;
    const first = initialStatus(def);
    const state: WorkflowStateValue = { status: first.key, category: first.category, unitId: def.responsibleUnitId ?? r.unitId, at: new Date().toISOString() };
    await tx.setRequestWorkflow(r.id, def.key, state);
    r.workflowStates = { ...r.workflowStates, [def.key]: state };
    if (when === 'purchase_done') {
      await tx.addRequestEvent({ requestId: r.id, actorId: actor.id, actorName: actor.name, kind: 'status', body: null, fromStatus: null, toStatus: first.key, workflow: def.key });
    }
  }
}

/** Added workflows that are open now, for emails ("waiting on Lab: Swapping on machines"). */
export function waitingOn(defs: ExtraWorkflow[], states: WorkflowStates): NonNullable<RequestChanged['waitingOn']> {
  return defs.flatMap((d) => {
    const s = states[d.key];
    return s && isOpenCategory(s.category) ? [{ name: d.name, responsibleUnitId: s.unitId, label: statusIn(d, s.status).label }] : [];
  });
}
