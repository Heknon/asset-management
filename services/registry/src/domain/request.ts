import { allowedMoves, AppError, statusIn, type RequestAccess, type RequestKind, type RequestStatus, type StatusCategory, type Workflow } from '@am/core';

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
  /** The team's own part (after the buying is done), if its item's kind has one. */
  team: TeamStage | null;
  createdAt: Date;
  updatedAt: Date;
  commentCount: number;
}

export interface TeamStage {
  variantId: string;
  /** The variant's unit. */
  unitId: string;
  status: string;
  category: StatusCategory;
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
export const isTeamOpen = (r: Pick<RequestState, 'team'>) => !!r.team && (r.team.category === 'todo' || r.team.category === 'active');

/**
 * Who does the team's part: members of the variant's unit or of a unit
 * beneath it on the way to the request's unit (Platform, or R&D above it when
 * R&D owns the variant), and the item's owner. Procurement, who handled the
 * buying, is not part of it unless they belong there.
 */
export function isTeamMember(p: { userId: string; units: Array<{ unitId: string }> }, r: Pick<RequestState, 'unitPath' | 'team'>, itemOwnerId: string | null): boolean {
  if (!r.team) return false;
  if (itemOwnerId && itemOwnerId === p.userId) return true;
  const from = r.unitPath.indexOf(r.team.unitId);
  const path = from >= 0 ? r.unitPath.slice(from) : [r.team.unitId];
  return p.units.some((u) => path.includes(u.unitId));
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
