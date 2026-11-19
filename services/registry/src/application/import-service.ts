import { AppError, type ImportBatch, type ImportRequest, type ImportResult, type ImportRowResult, type Principal } from '@am/core';
import type { AssetService } from './asset-service.js';
import type { RegistryStore } from './ports.js';

/** Thrown to undo a dry run after every row has been tried for real. */
class DryRun extends Error {}

const REFERENCE = /^\s*([A-Za-z][A-Za-z0-9]{0,5})-(\d{1,9})\s*$/;

/**
 * Imports rows prepared by the import wizard (already mapped and converted in
 * the browser). Every row goes through the normal create/update path, so
 * permissions, validation, IDs, search, reminders and activity are exactly
 * those of a hand-made item. A dry run does the same work and rolls it back,
 * so the preview never disagrees with the import.
 */
export class ImportService {
  constructor(
    private readonly store: RegistryStore,
    private readonly assets: AssetService,
  ) {}

  async run(p: Principal, req: ImportRequest): Promise<ImportResult> {
    const type = await this.store.getType(req.assetTypeId);
    if (!type) throw AppError.validation('Unknown asset type');
    let batchId = req.batchId ?? null;
    if (batchId && !req.dryRun) {
      const b = await this.store.getImportBatch(batchId);
      if (!b || b.createdBy !== p.userId || b.undoneAt) throw AppError.validation('Unknown import');
    }

    const results: ImportRowResult[] = [];
    const work = async (tx: RegistryStore) => {
      if (!req.dryRun && !batchId) batchId = await tx.insertImportBatch({ assetTypeId: type.id, fileName: req.fileName, createdBy: p.userId, createdByName: p.displayName });
      for (const row of req.rows) {
        if (Object.keys(row.issues).length) {
          results.push({ line: row.line, action: 'error', errors: row.issues });
          continue;
        }
        if (!row.name) {
          results.push({ line: row.line, action: 'error', errors: { name: 'Every row needs a name' } });
          continue;
        }
        const outcome = await tx.attempt(() => this.applyRow(tx, p, req, type.id, row, batchId));
        results.push(outcome.ok ? { line: row.line, ...outcome.value } : { line: row.line, action: 'error', errors: errorsOf(outcome.error) });
      }
      if (req.dryRun) throw new DryRun();
      await tx.addToImportBatch(batchId!, { created: results.filter((r) => r.action === 'create').length, updated: results.filter((r) => r.action === 'update').length });
    };
    try {
      await this.store.transaction(work);
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    const count = (a: ImportRowResult['action']) => results.filter((r) => r.action === a).length;
    return { batchId: req.dryRun ? null : batchId, rows: results, counts: { create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') } };
  }

  private async applyRow(tx: RegistryStore, p: Principal, req: ImportRequest, typeId: string, row: ImportRequest['rows'][number], batchId: string | null): Promise<Omit<ImportRowResult, 'line'>> {
    const common = {
      name: row.name,
      ...(row.ownerId !== undefined && { ownerId: row.ownerId }),
      ...(row.status && { status: row.status }),
      attributes: row.attributes,
    };
    if (req.mode === 'upsert') {
      const ref = req.matchBy === 'reference' && row.reference ? REFERENCE.exec(row.reference) : null;
      const field = req.matchBy.startsWith('field:') ? req.matchBy.slice(6) : null;
      const matches =
        req.matchBy === 'reference'
          ? ref
            ? await tx.findForImport(typeId, { reference: { prefix: ref[1]!.toUpperCase(), no: Number(ref[2]) } })
            : []
          : field
            ? row.attributes[field] !== undefined
              ? await tx.findForImport(typeId, { field: { key: field, value: row.attributes[field] } })
              : []
            : await tx.findForImport(typeId, { name: row.name, unitId: row.unitId });
      if (matches.length > 1) throw AppError.validation(`Matches ${matches.length} existing items; match by ID instead`);
      if (matches.length === 1) {
        const before = matches[0]!;
        const updated = await this.assets.update(p, before.id, { ...common, ...(row.unitId && { unitId: row.unitId }), ...(req.catalogId && { catalogId: req.catalogId }), ...(req.variantId && { variantId: req.variantId }) }, tx);
        return { action: new Date(updated.updatedAt).getTime() === before.updatedAt.getTime() ? 'unchanged' : 'update', assetId: updated.id, reference: updated.reference };
      }
      if (req.matchBy === 'reference' && row.reference) throw AppError.validation(`No item ${row.reference} to update`);
    }
    if (!row.unitId) throw AppError.validation('Choose the team that owns this row');
    const created = await this.assets.create(p, { assetTypeId: typeId, variantId: req.variantId, unitId: row.unitId, catalogId: req.catalogId, ownerId: row.ownerId ?? null, reminderOverrides: {}, ...common, ...(row.ownerId === undefined && { ownerId: p.userId }) }, tx);
    if (batchId) await tx.setImportBatch(created.id, batchId);
    return { action: 'create', assetId: created.id, reference: created.reference };
  }

  async list(p: Principal): Promise<ImportBatch[]> {
    return this.store.listImportBatches(p.isAdmin ? null : p.userId, 20);
  }

  /**
   * Removes the items an import created and nobody has changed since.
   * Items it updated keep their new values (their history shows the change).
   */
  async undo(p: Principal, id: string): Promise<{ removed: number }> {
    const batch = await this.store.getImportBatch(id);
    if (!batch || (batch.createdBy !== p.userId && !p.isAdmin)) throw AppError.notFound('Import');
    if (batch.undoneAt) throw AppError.conflict('This import was already undone');
    const ids = await this.store.untouchedImported(id);
    await this.store.transaction(async (tx) => {
      for (const assetId of ids) {
        const a = await tx.getAsset(assetId, { forUpdate: true });
        if (!a || a.version !== 1) continue;
        await tx.deleteAsset(assetId);
        await tx.addActivity({ assetId, actorId: p.userId, actorName: p.displayName, action: 'deleted', changes: { name: { from: a.name, to: null }, import: { from: batch.fileName, to: 'undone' } } });
        await tx.publish('asset.deleted', { assetId });
      }
      await tx.markImportUndone(id);
    });
    return { removed: ids.length };
  }
}

/** Field-level messages from validation, or one message for the row. */
function errorsOf(e: unknown): Record<string, string> {
  if (e instanceof AppError) {
    const fields = (e.details as { fields?: Record<string, string> } | undefined)?.fields;
    return fields && Object.keys(fields).length ? fields : { row: e.message };
  }
  return { row: 'Could not be imported' };
}
