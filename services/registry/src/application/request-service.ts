import {
  AppError,
  effectivePermissions,
  requestableUnitIds,
  scopesFor,
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
import { accessOf, assertTransition, isOpen, requestNumber, requestSearchText, type RequestState } from '../domain/request.js';
import type { RegistryStore } from './ports.js';

const requestEvents = metrics.counter({ name: 'am_request_events_total', help: 'Request workflow events (created, status changes, comments, assignments)', labelNames: ['kind', 'status'] });

/**
 * Intake: anyone asks for something on behalf of their team or any unit above
 * it; people with edit access on that unit (Procurement, team admins) handle
 * it through to fulfilment, which creates the asset.
 */
export class RequestService {
  constructor(private readonly store: RegistryStore) {}

  private visibility(p: Principal) {
    return { userId: p.userId, viewScopes: scopesFor(p, 'view'), editScopes: scopesFor(p, 'renew'), myUnitIds: p.units.map((u) => u.unitId) };
  }

  private isHandler(p: Principal, r: Pick<RequestState, 'unitPath' | 'assetTypeId'>) {
    return effectivePermissions(p, { unitPath: r.unitPath, assetTypeId: r.assetTypeId ?? '' }).has('renew');
  }

  private present(p: Principal, r: RequestState & { snippet?: string }): PurchaseRequest {
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
      status: r.status,
      quantity: r.quantity,
      estimatedCost: r.estimatedCost,
      neededBy: r.neededBy,
      link: r.link,
      assetId: r.assetId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      access: accessOf(this.isHandler(p, r), r.requesterId === p.userId),
      commentCount: r.commentCount,
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
    const ok = allowed === 'all' || allowed.has(unitId) || (allowed.size === 0 && unit.path.length === 1) || this.isHandler(p, { unitPath: unit.path, assetTypeId: null });
    if (!ok) throw AppError.forbidden('You can request things for your own team, or for a unit above it');
  }

  async list(p: Principal, q: RequestQuery): Promise<Page<PurchaseRequest>> {
    const { items, total } = await this.store.queryRequests(q, this.visibility(p));
    return { items: items.map((r) => this.present(p, r)), total, limit: q.limit, offset: q.offset };
  }

  counts(p: Principal): Promise<RequestCounts> {
    return this.store.countRequests(this.visibility(p));
  }

  async get(p: Principal, id: string) {
    return this.present(p, await this.load(p, id));
  }

  async forAsset(p: Principal, assetId: string) {
    const r = await this.store.requestForAsset(assetId);
    if (!r) return null;
    try {
      return this.present(p, await this.load(p, r.id));
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
    return this.store.transaction(async (tx) => {
      const draft = { ...input, seq: 0, requesterName: p.displayName };
      const created = await tx.insertRequest(input, { id: p.userId, name: p.displayName }, '');
      const withSearch = await tx.updateRequest(created.id, input, await this.searchText(tx, { ...draft, seq: created.seq }));
      await tx.addRequestEvent({ requestId: created.id, actorId: p.userId, actorName: p.displayName, kind: 'created', body: null, fromStatus: null, toStatus: 'submitted' });
      await this.publish(tx, withSearch, p, 'created', null, null);
      return this.present(p, withSearch);
    });
  }

  /** Requesters can edit while it is still being reviewed; handlers any time it is open. */
  async update(p: Principal, id: string, patch: RequestUpdate): Promise<PurchaseRequest> {
    return this.store.transaction(async (tx) => {
      const r = await this.load(p, id, { forUpdate: true }, tx);
      const handler = this.isHandler(p, r);
      const requesterCanEdit = r.requesterId === p.userId && (r.status === 'submitted' || r.status === 'in_review');
      if (!handler && !requesterCanEdit) throw AppError.forbidden('This request can no longer be edited');
      if (!isOpen(r.status)) throw AppError.validation('Closed requests cannot be edited');
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
      return this.present(p, saved);
    });
  }

  async act(p: Principal, id: string, action: RequestAction): Promise<PurchaseRequest> {
    return this.store.transaction(async (tx) => {
      const r = await this.load(p, id, { forUpdate: true }, tx);
      const handler = this.isHandler(p, r);
      switch (action.action) {
        case 'comment':
          await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'comment', body: action.body, fromStatus: null, toStatus: null });
          await this.publish(tx, r, p, 'comment', null, action.body);
          break;
        case 'status':
          if (action.status === 'fulfilled') throw AppError.validation('Fulfil a request by creating the asset it asked for');
          assertTransition(r.status, action.status, { isHandler: handler, isRequester: r.requesterId === p.userId });
          await tx.setRequestStatus(id, action.status);
          // Picking up a request assigns it, so the requester knows who is on it.
          if (handler && !r.assigneeId && (action.status === 'in_review' || action.status === 'approved')) await tx.setRequestAssignee(id, p.userId);
          await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'status', body: action.note ?? null, fromStatus: r.status, toStatus: action.status });
          await this.publish(tx, { ...r, status: action.status }, p, 'status', r.status, action.note ?? null);
          break;
        case 'assign':
          if (!handler) throw AppError.forbidden('Only people who handle requests for this team can assign them');
          if (action.assigneeId && !(await tx.activeUserIds([action.assigneeId])).size) throw AppError.validation('Unknown person');
          await tx.setRequestAssignee(id, action.assigneeId);
          await tx.addRequestEvent({ requestId: id, actorId: p.userId, actorName: p.displayName, kind: 'assigned', body: action.assigneeId, fromStatus: null, toStatus: null });
          await this.publish(tx, { ...r, assigneeId: action.assigneeId }, p, 'assigned', null, null);
          break;
      }
      return this.present(p, (await tx.getRequest(id))!);
    });
  }

  private publish(tx: RegistryStore, r: RequestState, p: Principal, kind: 'created' | 'status' | 'comment' | 'assigned', previousStatus: string | null, note: string | null) {
    requestEvents.inc({ kind, status: r.status });
    return tx.publish('request.changed', {
      requestId: r.id,
      number: requestNumber(r.seq),
      title: r.title,
      unitId: r.unitId,
      requesterId: r.requesterId,
      assigneeId: r.assigneeId,
      status: r.status,
      previousStatus,
      actorId: p.userId,
      actorName: p.displayName,
      note,
      kind,
    });
  }
}
