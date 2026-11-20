import { AppError, renewalDecisionMeta, type AssetComment, type CommentInput, type Principal, type RenewalCheckChanged } from '@am/core';
import type { AssetService } from './asset-service.js';
import type { RegistryStore } from './ports.js';

/**
 * The conversation on an asset: "is this still needed?", "vendor sent a new
 * quote", "@Dana can you approve the renewal?". Anyone who can see the asset
 * can read and post; mentioned people and the owner are emailed.
 */
export class CommentService {
  constructor(
    private readonly store: RegistryStore,
    private readonly assets: AssetService,
  ) {}

  async list(p: Principal, assetId: string): Promise<AssetComment[]> {
    await this.assets.reach(p, assetId, 'view');
    return this.store.listComments(assetId);
  }

  async create(p: Principal, assetId: string, input: CommentInput): Promise<AssetComment> {
    const { asset } = await this.assets.reach(p, assetId, 'comment');
    const mentionIds = await this.mentions(input.mentionIds, p.userId);
    return this.store.transaction(async (tx) => {
      const comment = (await tx.insertComment({ assetId, authorId: p.userId, authorName: p.displayName, body: input.body, mentionIds }))!;
      await tx.publish('asset.commented', {
        assetId,
        assetName: asset.name,
        commentId: comment.id,
        authorId: p.userId,
        authorName: p.displayName,
        excerpt: input.body.length > 400 ? `${input.body.slice(0, 400)}…` : input.body,
        mentionIds,
        ownerId: asset.ownerId,
      });
      return comment;
    });
  }

  /** Authors can edit their own messages (marked "edited"). */
  async update(p: Principal, commentId: string, input: CommentInput): Promise<AssetComment> {
    const comment = await this.load(p, commentId);
    if (comment.authorId !== p.userId || comment.kind !== 'message') throw AppError.forbidden('You can only edit your own messages');
    if (comment.deleted) throw AppError.validation('This message was deleted');
    return this.store.updateComment(commentId, { body: input.body, mentionIds: await this.mentions(input.mentionIds, p.userId) });
  }

  /** Authors, and people who manage the asset, can delete a message (a placeholder stays in the thread). */
  async remove(p: Principal, commentId: string): Promise<AssetComment> {
    const comment = await this.load(p, commentId);
    if (comment.authorId !== p.userId && !(await this.assets.reach(p, comment.assetId, 'view')).permissions.has('delete')) {
      throw AppError.forbidden('You can only delete your own messages');
    }
    return this.store.updateComment(commentId, { deleted: true });
  }

  /** Renewal checks become part of the asset's conversation, so the thread is the whole story. */
  async onRenewalCheck(e: RenewalCheckChanged): Promise<void> {
    if (!(await this.store.getAsset(e.assetId))) return;
    const decision = renewalDecisionMeta[e.status].label.replace(/^Owner: /, '').toLowerCase();
    const due = new Date(`${e.dueDate}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    // Rendered after the author's name: "Dana Cohen asked whether to renew …".
    const body =
      e.kind === 'asked'
        ? `asked whether to renew (${e.label.toLowerCase()} ${due})${e.text ? `: ${e.text}` : ''}`
        : `answered: ${decision}${e.text ? ` — ${e.text}` : ''}`;
    await this.store.insertComment({
      assetId: e.assetId,
      kind: 'renewal_check',
      sourceKey: `check:${e.obligationId}:${e.kind}:${e.at}`,
      authorId: e.actorId ?? '00000000-0000-0000-0000-000000000000',
      authorName: e.actorName,
      body,
      mentionIds: [],
    });
  }

  private async load(p: Principal, commentId: string): Promise<AssetComment> {
    const comment = await this.store.getComment(commentId);
    if (!comment) throw AppError.notFound('Message');
    await this.assets.reach(p, comment.assetId, 'view');
    return comment;
  }

  private async mentions(ids: string[], authorId: string): Promise<string[]> {
    const unique = [...new Set(ids)].filter((id) => id !== authorId);
    if (!unique.length) return [];
    const known = await this.store.activeUserIds(unique);
    return unique.filter((id) => known.has(id));
  }
}
