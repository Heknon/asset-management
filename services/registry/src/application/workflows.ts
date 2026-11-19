import { defaultWorkflow, firstOfCategory, statusIn, workflowSchema, type RequestChanged, type Workflow } from '@am/core';
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
): RequestChanged {
  const s = wf.statuses.find((x) => x.key === r.status) ?? { ...statusIn(wf, r.status), category: r.statusCategory };
  return {
    requestId: r.id,
    number: requestNumber(r.seq),
    title: r.title,
    unitId: r.unitId,
    requesterId: r.requesterId,
    assigneeId: r.assigneeId,
    status: r.status,
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
    at: new Date().toISOString(),
  };
}

/**
 * Renewing a date directly ("Renew" on the item) finishes the renewal
 * requests that were open for it, so the two never disagree.
 */
export async function completeRenewals(tx: RegistryStore, assetId: string, fieldKey: string, actor: { id: string; name: string }, skipRequestId?: string): Promise<void> {
  for (const r of await tx.openRenewals(assetId, fieldKey)) {
    if (r.id === skipRequestId) continue;
    const wf = await workflowFor(tx, r.assetTypeId);
    const done = firstOfCategory(wf, 'done')!;
    await tx.setRequestStatus(r.id, done);
    await tx.addRequestEvent({ requestId: r.id, actorId: actor.id, actorName: actor.name, kind: 'fulfilled', body: 'Renewed on the item', fromStatus: r.status, toStatus: done.key });
    await tx.publish('request.changed', requestChangedEvent({ ...r, status: done.key, statusCategory: 'done' }, wf, actor, 'fulfilled', r.status, null));
  }
}
