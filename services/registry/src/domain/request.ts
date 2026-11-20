import { allowedMoves, AppError, statusIn, type RequestAccess, type RequestKind, type RequestStatus, type StatusCategory, type Workflow, type WorkflowStates } from '@am/core';

/** Pure rules of the request workflow. */

export interface RequestState {
  id: string;
  seq: number;
  title: string;
  description: string;
  unitId: string;
  unitPath: string[];
  assetTypeId: string | null;
  requesterId: string;
  requesterName: string;
  assigneeId: string | null;
  status: RequestStatus;
  statusCategory: StatusCategory;
  kind: RequestKind;
  renewal: { assetId: string; fieldKey: string; obligationId: string | null } | null;
  quantity: number | null;
  estimatedCost: { amount: number; currency: string } | null;
  neededBy: string | null;
  link: string | null;
  assetId: string | null;
  /** Where each added workflow stands (those started so far). */
  workflowStates: WorkflowStates;
  /** The team variant whose workflows it follows (the renewed or purchased item's). */
  workflowVariantId: string | null;
  createdAt: Date;
  updatedAt: Date;
  commentCount: number;
}

export const requestNumber = (seq: number) => `REQ-${seq}`;

/** Requesters and handlers can each make only the moves their workflow gives them. */
export function assertMove(wf: Workflow, from: RequestStatus, to: RequestStatus, actor: { isHandler: boolean; isRequester: boolean }): void {
  if (from === to) throw AppError.validation(`The request is already ${statusIn(wf, to).label.toLowerCase()}`);
  if (allowedMoves(wf, from, actor).some((s) => s.key === to)) return;
  const exists = wf.transitions.some((x) => x.from === from && x.to === to);
  if (!exists) throw AppError.validation(`A request cannot go from ${statusIn(wf, from).label} to ${statusIn(wf, to).label}`);
  throw AppError.forbidden('Only people who handle requests for this team can do that');
}

/** The buyers' part is still open. */
export const isOpen = (r: Pick<RequestState, 'statusCategory'>) => r.statusCategory === 'todo' || r.statusCategory === 'active';
export function accessOf(isHandler: boolean, isRequester: boolean): RequestAccess {
  return isHandler ? 'handler' : isRequester ? 'requester' : 'viewer';
}

/** What is searchable about a request. */
export function requestSearchText(r: Pick<RequestState, 'seq' | 'title' | 'description' | 'requesterName' | 'link'>, unitName: string, typeName: string | null): string {
  return [requestNumber(r.seq), r.title, r.description, `Requested by: ${r.requesterName}`, `For: ${unitName}`, typeName && `Type: ${typeName}`, r.link]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 20_000);
}
