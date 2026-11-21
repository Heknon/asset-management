import {
  allowedMoves,
  AppError,
  behaviorOf,
  combineStatuses,
  effectivePermissions,
  initialStatus,
  requestableUnitIds,
  scopesFor,
  spendOf,
  statusIn,
  withVariant,
  type RenewalCheckChanged,
  type RenewalRequestInput,
  type RequestStatusInfo,
  type Workflow,
  type Page,
  type Principal,
  type PurchaseRequest,
  type RequestAction,
  type RequestCounts,
  type RequestCreate,
  type RequestQuery,
  type RequestUpdate,
} from '@am/core';
import { metrics } from '@am/platform';
import { accessOf, assertMove, isOpen, requestNumber, requestSearchText, type RequestState } from '../domain/request.js';
import type { AssetService } from './asset-service.js';
import { finishPurchase, publishRequestChange, purchaseUnit, requestWorkflowDefs, Responsibility, startRequestWorkflows, workflowFor, workflowView } from './workflows.js';
import type { RegistryStore, RequestRow } from './ports.js';

const requestEvents = metrics.counter({ name: 'am_request_events_total', help: 'Request workflow events (created, status changes, comments, assignments)', labelNames: ['kind', 'status'] });

/**
 * Intake: anyone asks for something on behalf of their team or any unit above
 * it; people with edit access on that unit (Procurement, team admins) handle
 * it through to fulfilment, which creates the asset.
 */
export class RequestService {
  constructor(
    private readonly store: RegistryStore,
    private readonly assets: AssetService,
  ) {}

  private async visibility(p: Principal) {
    // Members of the unit responsible for purchases handle every purchase.
    const unit = await purchaseUnit(this.store);
    const buyer = !!unit && (await new Responsibility(this.store, p).canAct(unit));
    return { userId: p.userId, viewScopes: scopesFor(p, 'view'), editScopes: buyer ? [{ unitId: null, assetTypeId: null }] : scopesFor(p, 'renew'), myUnitIds: p.units.map((u) => u.unitId) };
  }

  /** Handles the purchase: may renew there, or belongs to the unit responsible for purchases. */
  private async isHandler(p: Principal, r: Pick<RequestState, 'unitPath' | 'assetTypeId'>, store = this.store) {
    if (effectivePermissions(p, { unitPath: r.unitPath, assetTypeId: r.assetTypeId ?? '' }).has('renew')) return true;
    const unit = await purchaseUnit(store);
    return !!unit && (await new Responsibility(store, p).canAct(unit));
  }

  private async presentAll(p: Principal, rows: Array<RequestState & { snippet?: string }>, store = this.store): Promise<PurchaseRequest[]> {
    const workflows = new Map<string, Workflow>();
    const defsBy = new Map<string, Awaited<ReturnType<typeof requestWorkflowDefs>>>();
    const resp = new Responsibility(store, p);
    const can = new Map<string, boolean>();
    const canAct = async (unitId: string) => {
      if (!can.has(unitId)) can.set(unitId, await resp.canAct(unitId));
      return can.get(unitId)!;
    };
    const buyingUnit = await purchaseUnit(store);
    const buyer = !!buyingUnit && (await canAct(buyingUnit));
    const out: PurchaseRequest[] = [];
    for (const r of rows) {
      const k = r.assetTypeId ?? '';
      if (!workflows.has(k)) workflows.set(k, await workflowFor(store, r.assetTypeId));
      const dk = `${k}/${r.workflowVariantId ?? ''}`;
      if (!defsBy.has(dk)) defsBy.set(dk, await requestWorkflowDefs(store, r));
      const defs = defsBy.get(dk)!;
      const units = new Map<string, boolean>();
      for (const d of defs) {
        const u = r.workflowStates[d.key]?.unitId ?? d.responsibleUnitId ?? r.unitId;
        units.set(u, await canAct(u));
      }
      const handler = buyer || effectivePermissions(p, { unitPath: r.unitPath, assetTypeId: r.assetTypeId ?? '' }).has('renew');
      out.push(this.present(p, r, workflows.get(k)!, handler, buyingUnit, defs, (u) => units.get(u) ?? false));
    }
    return out;
  }

  private present(
    p: Principal,
    r: RequestState & { snippet?: string },
    wf: Workflow,
    handler: boolean,
    buyingUnit: string | null,
    defs: Awaited<ReturnType<typeof requestWorkflowDefs>>,
    canAct: (unitId: string) => boolean,
  ): PurchaseRequest {
    const info = (s: { key: string; label: string; color: string; category: RequestStatusInfo['category'] }): RequestStatusInfo => ({ key: s.key, label: s.label, color: s.color, category: s.category });
    // Added workflows can be moved while the purchase has not been called off.
    const live = r.statusCategory !== 'closed';
    const workflows = defs.map((d) => {
      const u = r.workflowStates[d.key]?.unitId ?? d.responsibleUnitId ?? r.unitId;
      return workflowView(d, r.workflowStates[d.key], { ownUnitId: r.unitId, canAct: canAct(u), isRequester: r.requesterId === p.userId, open: live });
    });
    const overall = combineStatuses([
      { key: 'purchase', category: r.statusCategory, started: true },
      ...workflows.map((w) => ({ key: w.key, category: w.statusInfo?.category ?? 'todo', started: w.started })),
    ]);
    // Done statuses of purchases for a template are reached by creating the item, not by a button.
    const moves = isOpen(r) ? allowedMoves(wf, r.status, { isHandler: handler, isRequester: r.requesterId === p.userId }).filter((s) => !(s.category === 'done' && r.kind === 'purchase' && r.assetTypeId)) : [];
    return {
      id: r.id,
      number: requestNumber(r.seq),
      title: r.title,
      description: r.description,
      unitId: r.unitId,
      assetTypeId: r.assetTypeId,
      requesterId: r.requesterId,
      requesterName: r.requesterName,
      assigneeId: r.assigneeId,
      kind: r.kind,
      status: r.status,
      statusInfo: info(wf.statuses.some((s) => s.key === r.status) ? statusIn(wf, r.status) : { ...statusIn(wf, r.status), category: r.statusCategory }),
      moves: moves.map(info),
      statuses: wf.statuses.map(info),
      renewal: r.renewal,
      quantity: r.quantity,
      estimatedCost: r.estimatedCost,
      neededBy: r.neededBy,
      link: r.link,
      assetId: r.assetId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      access: accessOf(handler, r.requesterId === p.userId),
      commentCount: r.commentCount,
      responsibleUnitId: buyingUnit,
      workflows,
      overall,
      ...(r.snippet && { snippet: r.snippet }),
    };
  }

  private async load(p: Principal, id: string, opts?: { forUpdate?: boolean }, store = this.store) {
    const r = await store.getRequest(id, opts);
    const visible = r && (r.requesterId === p.userId || effectivePermissions(p, { unitPath: r.unitPath, assetTypeId: r.assetTypeId ?? '' }).has('view'));
    if (!r || !visible) throw AppError.notFound('Request');
    return r;
  }

  private async searchText(store: RegistryStore, r: Pick<RequestState, 'seq' | 'title' | 'description' | 'requesterName' | 'link' | 'unitId' | 'assetTypeId'>) {
    const [unit, type] = await Promise.all([store.getUnit(r.unitId), r.assetTypeId ? store.getType(r.assetTypeId) : null]);
    return requestSearchText(r, unit?.name ?? '', type?.name ?? null);
  }

  /** You can ask on behalf of any unit you belong to or that sits above it. People in no unit can ask for the top level. */
  private async assertCanRequestFor(p: Principal, unitId: string) {
    const unit = await this.store.getUnit(unitId);
    if (!unit || unit.archived) throw AppError.validation('Unknown or archived team');
    const paths = await this.store.unitPaths(p.units.map((u) => u.unitId));
    const allowed = requestableUnitIds(p, (id) => paths.get(id));
    const ok = allowed === 'all' || allowed.has(unitId) || (allowed.size === 0 && unit.path.length === 1) || (await this.isHandler(p, { unitPath: unit.path, assetTypeId: null }));
    if (!ok) throw AppError.forbidden('You can request things for your own team, or for a unit above it');
  }

  async list(p: Principal, q: RequestQuery): Promise<Page<PurchaseRequest>> {
    const { items, total } = await this.store.queryRequests(q, await this.visibility(p));
    return { items: await this.presentAll(p, items), total, limit: q.limit, offset: q.offset };
  }

  async counts(p: Principal): Promise<RequestCounts> {
    return this.store.countRequests(await this.visibility(p));
  }

  async get(p: Principal, id: string) {
    return (await this.presentAll(p, [await this.load(p, id)]))[0]!;
  }

  async forAsset(p: Principal, assetId: string) {
    const r = await this.store.requestForAsset(assetId);
    if (!r) return null;
    try {
      return await this.get(p, r.id);
    } catch {
      return null;
    }
  }

  async events(p: Principal, id: string) {
    await this.load(p, id);
    return this.store.listRequestEvents(id);
  }

  async create(p: Principal, input: RequestCreate): Promise<PurchaseRequest> {
    await this.assertCanRequestFor(p, input.unitId);
    if (input.assetTypeId && !(await this.store.getType(input.assetTypeId))) throw AppError.validation('Unknown asset type');
    return this.store.transaction(async (tx) => (await this.presentAll(p, [await this.insert(tx, input, { id: p.userId, name: p.displayName })], tx))[0]!);
  }

  /** Creates a request at its workflow's first status (purchases, and renewals opened by the system). */
  private async insert(tx: RegistryStore, input: RequestCreate & Pick<RequestRow, 'kind' | 'renewal'>, actor: { id: string; name: string }, variantId: string | null = null): Promise<RequestState> {
    const wf = await workflowFor(tx, input.assetTypeId);
    const first = initialStatus(wf);
    const created = await tx.insertRequest(input, actor, '', first);
    const withSearch = await tx.updateRequest(created.id, input, await this.searchText(tx, { ...input, seq: created.seq, requesterName: actor.name }));
    // A renewal follows the renewed item's team variant; workflows that run alongside the purchase start now.
    if (variantId) {
      await tx.setRequestWorkflowVariant(created.id, variantId);
      withSearch.workflowVariantId = variantId;
    }
    await startRequestWorkflows(tx, withSearch, 'created', actor);
    await tx.addRequestEvent({ requestId: created.id, actorId: actor.id, actorName: actor.name, kind: 'created', body: null, fromStatus: null, toStatus: first.key });
    await this.publish(tx, withSearch, wf, actor, 'created', null, null);
    return withSearch;
  }

  /**
   * "Please renew X": a renewal request for a date of an item, following the
   * item's workflow. Anyone who can see the item may ask (owners usually do).
   */
  async requestRenewal(p: Principal, assetId: string, input: RenewalRequestInput): Promise<PurchaseRequest> {
    const { asset } = await this.assets.reach(p, assetId, 'view');
    return this.store.transaction(async (tx) => {
      const r = await this.renewalFor(tx, asset.id, input.fieldKey, input.obligationId, input.note, { id: p.userId, name: p.displayName });
      return (await this.presentAll(p, [r], tx))[0]!;
    });
  }

  /** The owner answered "renew" (or "renew with changes"): open the renewal request for whoever buys it. */
  async onRenewalCheck(e: RenewalCheckChanged): Promise<void> {
    if (e.kind !== 'answered' || (e.status !== 'renew' && e.status !== 'change') || !e.actorId) return;
    try {
      await this.store.transaction((tx) =>
        this.renewalFor(tx, e.assetId, null, e.obligationId, [e.status === 'change' ? 'Renew with changes.' : 'Renew as is.', e.text].filter(Boolean).join(' '), { id: e.actorId!, name: e.actorName }, e.label),
      );
    } catch (err) {
      // Already open for this occurrence (redelivery, or someone opened one by hand), or the item is gone.
      if (err instanceof AppError && (err.code === 'conflict' || err.code === 'not_found')) return;
      throw err;
    }
  }

  private async renewalFor(tx: RegistryStore, assetId: string, fieldKey: string | null, obligationId: string | null, note: string, actor: { id: string; name: string }, label?: string): Promise<RequestState> {
    const asset = await tx.getAsset(assetId);
    if (!asset) throw AppError.notFound('Asset');
    const type = (await tx.getType(asset.assetTypeId))!;
    const variant = asset.variantId ? await tx.getVariant(asset.variantId) : null;
    const schema = withVariant(type, variant);
    // From the renewal check we know the date's label; find its field.
    const field = schema.fields.find((f) => f.kind === 'date' && (fieldKey ? f.key === fieldKey : f.label === label)) ?? schema.fields.find((f) => f.kind === 'date' && f.config.tracking);
    if (!field) throw AppError.validation('This item has no date to renew');
    if (fieldKey && field.key !== fieldKey) throw AppError.validation('Unknown date');
    const open = await tx.openRenewals(asset.id, field.key);
    if (open.length) throw AppError.conflict(`A renewal request is already open: ${requestNumber(open[0]!.seq)}`);
    const due = asset.values[field.key];
    return this.insert(
      tx,
      {
        title: `Renew ${asset.name}`,
        description: note,
        unitId: asset.unitId,
        assetTypeId: asset.assetTypeId,
        quantity: null,
        estimatedCost: spendOf(schema.fields, asset.values),
        neededBy: typeof due === 'string' ? due : null,
        link: null,
        kind: 'renewal',
        renewal: { assetId: asset.id, fieldKey: field.key, obligationId },
      },
      actor,
      asset.variantId,
    );
  }

  /** Requesters can edit while it is still waiting to be picked up; handlers any time it is open. */
  async update(p: Principal, id: string, patch: RequestUpdate): Promise<PurchaseRequest> {
    return this.store.transaction(async (tx) => {
      const r = await this.load(p, id, { forUpdate: true }, tx);
      const handler = await this.isHandler(p, r, tx);
      const requesterCanEdit = r.requesterId === p.userId && r.statusCategory === 'todo';
      if (!handler && !requesterCanEdit) throw AppError.forbidden('This request can no longer be edited');
      if (!isOpen(r)) throw AppError.validation('Closed requests cannot be edited');
      if (patch.unitId && patch.unitId !== r.unitId) await this.assertCanRequestFor(p, patch.unitId);
      const row = {
        title: patch.title ?? r.title,
        description: patch.description ?? r.description,
        unitId: patch.unitId ?? r.unitId,
        assetTypeId: patch.assetTypeId !== undefined ? patch.assetTypeId : r.assetTypeId,
        quantity: patch.quantity !== undefined ? patch.quantity : r.quantity,
        estimatedCost: patch.estimatedCost !== undefined ? patch.estimatedCost : r.estimatedCost,
        neededBy: patch.neededBy !== undefined ? patch.neededBy : r.neededBy,
        link: patch.link !== undefined ? patch.link : r.link,
      };
      const saved = await tx.updateRequest(id, row, await this.searchText(tx, { ...row, seq: r.seq, requesterName: r.requesterName }));
      await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'edited', body: null, fromStatus: null, toStatus: null });
      return (await this.presentAll(p, [saved], tx))[0]!;
    });
  }

  async act(p: Principal, id: string, action: RequestAction): Promise<PurchaseRequest> {
    return this.store.transaction(async (tx) => {
      const r = await this.load(p, id, { forUpdate: true }, tx);
      const handler = await this.isHandler(p, r, tx);
      const wf = await workflowFor(tx, r.assetTypeId);
      const actor = { id: p.userId, name: p.displayName };
      switch (action.action) {
        case 'comment':
          await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'comment', body: action.body, fromStatus: null, toStatus: null });
          await this.publish(tx, r, wf, actor, 'comment', null, action.body);
          break;
        case 'status': {
          if (action.workflow) {
            await this.moveWorkflow(tx, p, r, wf, action.workflow, action.status, action.note ?? null);
            break;
          }
          const to = statusIn(wf, action.status);
          if (!wf.statuses.some((s) => s.key === action.status)) throw AppError.validation(`Unknown status "${action.status}"`);
          assertMove(wf, r.status, to.key, { isHandler: handler, isRequester: r.requesterId === p.userId });
          if (to.category === 'done' && r.kind === 'purchase' && r.assetTypeId) throw AppError.validation('Finish a purchase by creating the item it asked for (“Create item”)');
          // Finishing a renewal rolls the item's date forward: one term (repeating dates), or to the date given.
          if (to.category === 'done' && r.renewal) {
            const asset = await tx.getAsset(r.renewal.assetId);
            const sch = asset ? await this.assets.schemaOf(tx, asset) : null;
            const field = sch?.schema.fields.find((f) => f.key === r.renewal!.fieldKey);
            if (asset && field?.kind === 'date' && field.config.tracking && action.renewedUntil) await this.assets.advance(p, asset.id, field.key, { store: tx, skipRequestId: id, until: action.renewedUntil });
            else if (asset && field?.kind === 'date' && field.config.tracking?.recurrence !== undefined) await this.assets.advance(p, asset.id, field.key, { store: tx, skipRequestId: id });
            else if (asset && field?.kind === 'date' && field.config.tracking) {
              const kinds = await tx.listDateKinds();
              const kind = kinds.find((k) => k.id === field.config.tracking!.dateKindId);
              if (kind && behaviorOf(field, kind) === 'recurring') await this.assets.advance(p, asset.id, field.key, { store: tx, skipRequestId: id });
            }
          }
          // Picking up a request assigns it, so the requester knows who is on it.
          if (handler && !r.assigneeId && r.statusCategory === 'todo' && to.category === 'active') await tx.setRequestAssignee(id, p.userId);
          if (to.category === 'done') {
            await finishPurchase(tx, r, wf, to, actor, { body: action.note ?? null, note: action.note ?? null });
            break;
          }
          await tx.setRequestStatus(id, to);
          await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'status', body: action.note ?? null, fromStatus: r.status, toStatus: to.key });
          await this.publish(tx, { ...r, status: to.key, statusCategory: to.category }, wf, actor, 'status', r.status, action.note ?? null);
          break;
        }
        case 'assign':
          if (!handler) throw AppError.forbidden('Only people who handle requests for this team can assign them');
          if (action.assigneeId && !(await tx.activeUserIds([action.assigneeId])).size) throw AppError.validation('Unknown person');
          await tx.setRequestAssignee(id, action.assigneeId);
          await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'assigned', body: action.assigneeId, fromStatus: null, toStatus: null });
          await this.publish(tx, { ...r, assigneeId: action.assigneeId }, wf, actor, 'assigned', null, null);
          break;
      }
      return (await this.presentAll(p, [(await tx.getRequest(id))!], tx))[0]!;
    });
  }

  /**
   * Moves one of the request's added workflows ("Swap the new license":
   * To install → Swapping on machines). Its responsible unit moves it; the
   * requester makes the moves marked for them.
   */
  private async moveWorkflow(tx: RegistryStore, p: Principal, r: RequestState, wf: Workflow, key: string, status: string, note: string | null) {
    const def = (await requestWorkflowDefs(tx, r)).find((d) => d.key === key);
    if (!def) throw AppError.notFound('Workflow');
    const state = r.workflowStates[key];
    if (!state) throw AppError.validation(def.startsWhen === 'purchase_done' ? `${def.name} starts once the purchase is done` : `${def.name} has not started`);
    if (r.statusCategory === 'closed') throw AppError.validation('This request was closed');
    const to = def.statuses.find((s) => s.key === status);
    if (!to) throw AppError.validation(`Unknown status "${status}"`);
    const from = statusIn(def, state.status);
    if (from.key === to.key) throw AppError.validation(`It is already ${to.label.toLowerCase()}`);
    const actor = { isHandler: await new Responsibility(tx, p).canAct(state.unitId), isRequester: r.requesterId === p.userId };
    if (!allowedMoves(def, from.key, actor).some((s) => s.key === to.key)) {
      if (!def.transitions.some((x) => x.from === from.key && x.to === to.key)) throw AppError.validation(`${def.name} cannot go from ${from.label} to ${to.label}`);
      throw AppError.forbidden(`${def.name} is moved by the unit responsible for it`);
    }
    const next = { ...state, status: to.key, category: to.category, at: new Date().toISOString() };
    await tx.setRequestWorkflow(r.id, key, next);
    r.workflowStates = { ...r.workflowStates, [key]: next };
    await tx.addRequestEvent({ requestId: r.id, actorId: p.userId, actorName: p.displayName, kind: 'status', body: note, fromStatus: from.key, toStatus: to.key, workflow: key });
    requestEvents.inc({ kind: 'workflow', status: to.key });
    await publishRequestChange(tx, r, wf, { id: p.userId, name: p.displayName }, 'status', from.key, note, { def, state: next });
  }

  private publish(tx: RegistryStore, r: RequestState, wf: Workflow, actor: { id: string; name: string }, kind: 'created' | 'status' | 'comment' | 'assigned' | 'fulfilled', previousStatus: string | null, note: string | null) {
    requestEvents.inc({ kind, status: r.status });
    return publishRequestChange(tx, r, wf, actor, kind, previousStatus, note);
  }
}
