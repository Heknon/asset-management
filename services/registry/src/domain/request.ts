import { AppError, requestTransitions, type RequestAccess, type RequestStatus } from '@am/core';

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
  quantity: number | null;
  estimatedCost: { amount: number; currency: string } | null;
  neededBy: string | null;
  link: string | null;
  assetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  commentCount: number;
}

export const requestNumber = (seq: number) => `REQ-${seq}`;

/** Requester and handler can each make only their own moves (see requestTransitions). */
export function assertTransition(from: RequestStatus, to: RequestStatus, actor: { isHandler: boolean; isRequester: boolean }): void {
  if (from === to) throw AppError.validation(`The request is already ${to.replace('_', ' ')}`);
  const who = requestTransitions[from][to];
  if (!who) throw AppError.validation(`A request cannot go from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}`);
  if (who === 'handler' && !actor.isHandler) throw AppError.forbidden('Only people who handle requests for this team can do that');
  if (who === 'requester' && !actor.isRequester && !actor.isHandler) throw AppError.forbidden('Only the requester can cancel this request');
}

export function isOpen(status: RequestStatus): boolean {
  return status === 'submitted' || status === 'in_review' || status === 'approved' || status === 'ordered';
}

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
