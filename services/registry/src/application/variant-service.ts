import { AppError, canManageTemplates, typeVariantInputSchema, unitPermissions, validateVariantStructure, type Principal, type TypeVariant, type TypeVariantInput } from '@am/core';
import type { RegistryStore } from './ports.js';
import { republishAssets } from './type-service.js';

/**
 * Team variants: a unit extends an organization template with the fields it
 * needs ("Design license" = Software license + workstation + MAC addresses).
 * Managers of the unit (Manage access) and template managers create them;
 * everyone in the unit and beneath it can use them.
 */
export class VariantService {
  constructor(private readonly store: RegistryStore) {}

  /** Variants of a template, or those usable in a unit (its own and its ancestors'). */
  async list(q: { assetTypeId?: string; unitId?: string; includeArchived?: boolean }): Promise<TypeVariant[]> {
    let unitIds: string[] | undefined;
    if (q.unitId) unitIds = (await this.store.getUnit(q.unitId))?.path ?? [];
    return this.store.listVariants({ assetTypeId: q.assetTypeId, unitIds, includeArchived: q.includeArchived });
  }

  async get(id: string): Promise<TypeVariant> {
    const v = await this.store.getVariant(id);
    if (!v) throw AppError.notFound('Variant');
    return v;
  }

  async create(p: Principal, assetTypeId: string, input: TypeVariantInput): Promise<TypeVariant> {
    const parsed = typeVariantInputSchema.parse(input);
    await this.assertCanManage(p, parsed.unitId);
    await this.validated(assetTypeId, parsed);
    return this.store.insertVariant(assetTypeId, parsed, p.displayName);
  }

  async update(p: Principal, id: string, input: Omit<TypeVariantInput, 'unitId'>, expectedVersion: number): Promise<TypeVariant> {
    const current = await this.get(id);
    await this.assertCanManage(p, current.unitId);
    const parsed = typeVariantInputSchema.parse({ ...input, unitId: current.unitId });
    await this.validated(current.assetTypeId, parsed);
    return this.store.transaction(async (tx) => {
      const saved = await tx.updateVariant(id, parsed, expectedVersion);
      // Tracked dates may have changed: let the scheduler re-read every item of the variant.
      await republishAssets(tx, { variantIds: [id] });
      return saved;
    });
  }

  async setArchived(p: Principal, id: string, archived: boolean): Promise<TypeVariant> {
    const current = await this.get(id);
    await this.assertCanManage(p, current.unitId);
    return this.store.setVariantArchived(id, archived);
  }

  async canManage(p: Principal, unitId: string): Promise<boolean> {
    if (canManageTemplates(p, await this.store.rootUnitIds())) return true;
    const unit = await this.store.getUnit(unitId);
    return !!unit && unitPermissions(p, unit.path).has('manage');
  }

  private async assertCanManage(p: Principal, unitId: string) {
    if (!(await this.canManage(p, unitId))) throw AppError.forbidden('Team templates are managed by the unit’s managers (“Manage access”) and template managers');
  }

  private async validated(assetTypeId: string, input: TypeVariantInput) {
    const type = await this.store.getType(assetTypeId);
    if (!type) throw AppError.notFound('Asset type');
    const unit = await this.store.getUnit(input.unitId);
    if (!unit || unit.archived) throw AppError.validation('Unknown or archived unit');
    const kinds = await this.store.listDateKinds();
    const issues = validateVariantStructure(type, input, new Set(kinds.map((k) => k.id)));
    if (issues.length) throw AppError.validation('The variant has problems', { issues });
  }
}
