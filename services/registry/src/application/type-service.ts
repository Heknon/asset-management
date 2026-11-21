import {
  AppError,
  canManageTemplates,
  firstOfCategory,
  initialStatus,
  validateWorkflow,
  workflowSchema,
  type Workflow,
  type Principal,
  assetTypeInputSchema,
  dateKindInputSchema,
  instantiateTemplate,
  starterTemplates,
  validateTypeStructure,
  type AssetType,
  type AssetTypeInput,
  type DateKind,
  type DateKindInput,
} from '@am/core';
import { assetChangedEvent } from '../domain/asset.js';
import type { RegistryStore } from './ports.js';
import { DEFAULT_WORKFLOW_KEY, organizationWorkflow, PURCHASE_UNIT_KEY, purchaseUnit } from './workflows.js';
import { itemSchema } from './schema.js';

export interface TemplateSummary {
  key: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  fieldCount: number;
  trackedDates: string[];
}

/** Asset types (templates), date kinds and the starter template gallery. */
export class TypeService {
  constructor(private readonly store: RegistryStore) {}

  /**
   * Templates are shared by the whole organization: administrators and people
   * who manage it as a whole (e.g. Procurement as Admin of the company) change them.
   */
  async assertCanManage(p: Principal): Promise<void> {
    if (!canManageTemplates(p, await this.store.rootUnitIds())) throw AppError.forbidden('Changing templates needs “Manage access” on the whole organization');
  }

  async canManage(p: Principal): Promise<boolean> {
    return canManageTemplates(p, await this.store.rootUnitIds());
  }

  listDateKinds() {
    return this.store.listDateKinds();
  }

  async createDateKind(input: DateKindInput): Promise<DateKind> {
    return this.store.createDateKind(dateKindInputSchema.parse(input));
  }

  /** Kind semantics feed every tracked date using it, so affected assets are re-published. */
  async updateDateKind(id: string, input: DateKindInput & { archived: boolean }): Promise<DateKind> {
    return this.store.transaction(async (tx) => {
      const kind = await tx.updateDateKind(id, input);
      const types = (await tx.listTypes(true)).filter((t) => t.fields.some((f) => f.kind === 'date' && f.config.tracking?.dateKindId === id));
      await republishAssets(tx, { typeIds: types.map((t) => t.id) });
      return kind;
    });
  }

  listTypes(includeArchived = false) {
    return this.store.listTypes(includeArchived);
  }

  async getType(id: string): Promise<AssetType> {
    const type = await this.store.getType(id);
    if (!type) throw AppError.notFound('Asset type');
    return type;
  }

  async createType(input: AssetTypeInput): Promise<AssetType> {
    const parsed = await this.validated(input);
    return this.store.createType(parsed);
  }

  /**
   * Schema changes are versioned. Existing values stay stored; values that no
   * longer fit surface as validation errors the next time the asset is edited.
   */
  async updateType(id: string, input: AssetTypeInput, expectedVersion: number): Promise<AssetType> {
    const current = await this.store.getType(id);
    if (!current) throw AppError.notFound('Asset type');
    // Older clients do not send the workflow: keep the one it has.
    const parsed = await this.validated({
      ...input,
      ...(input.requestWorkflow === undefined && { requestWorkflow: current.requestWorkflow ?? null }),
      ...(input.workflows === undefined && { workflows: current.workflows ?? [] }),
    });
    const before = current.requestWorkflow ?? (await organizationWorkflow(this.store));
    const after = parsed.requestWorkflow ?? (await organizationWorkflow(this.store));

    // A field added to the template must not clash with a team variant's own field.
    const variants = await this.store.listVariants({ assetTypeId: id, includeArchived: true });
    const issues = [
      ...parsed.fields.flatMap((f, i) =>
        variants.filter((v) => v.fields.some((x) => x.key === f.key)).map((v) => ({ path: `fields.${i}.key`, message: `The team variant “${v.name}” already has a field "${f.key}"` })),
      ),
      // Likewise a workflow: items and requests keep each workflow's state under its key.
      ...(parsed.workflows ?? []).flatMap((w, i) =>
        variants.filter((v) => (v.workflows ?? []).some((x) => x.key === w.key)).map((v) => ({ path: `workflows.${i}.key`, message: `The team variant “${v.name}” already has a workflow "${w.key}"` })),
      ),
    ];
    if (issues.length) throw AppError.validation('The template has problems', { issues });
    return this.store.transaction(async (tx) => {
      const type = await tx.updateType(id, parsed, expectedVersion);
      await this.moveOpenRequests(tx, before, after, [id]);
      await republishAssets(tx, { typeIds: [id] });
      return type;
    });
  }

  /** The organization's default request workflow, which templates without their own follow. */
  organizationWorkflow() {
    return organizationWorkflow(this.store);
  }

  purchaseUnit() {
    return purchaseUnit(this.store);
  }

  async setPurchaseUnit(unitId: string | null): Promise<string | null> {
    if (unitId) {
      const u = await this.store.getUnit(unitId);
      if (!u || u.archived) throw AppError.validation('Unknown or archived unit');
    }
    await this.store.putSetting(PURCHASE_UNIT_KEY, unitId);
    return unitId;
  }

  async setOrganizationWorkflow(input: Workflow): Promise<Workflow> {
    const wf = workflowSchema.parse(input);
    const issues = validateWorkflow(wf);
    if (issues.length) throw AppError.validation('The workflow has problems', { issues });
    const before = await organizationWorkflow(this.store);
    await this.store.transaction(async (tx) => {
      await tx.putSetting(DEFAULT_WORKFLOW_KEY, wf);
      await this.moveOpenRequests(tx, before, wf, 'default');
    });
    return wf;
  }

  /**
   * Open requests in a status the new workflow no longer has (or whose meaning
   * changed) move to its first status of the same kind, else to its start.
   * Finished requests keep the status they ended in, as history.
   */
  private async moveOpenRequests(store: RegistryStore, before: Workflow, after: Workflow, typeIds: string[] | 'default'): Promise<void> {
    for (const s of before.statuses) {
      if (s.category === 'done' || s.category === 'closed') continue;
      const same = after.statuses.find((x) => x.key === s.key);
      if (same && same.category === s.category) continue;
      const to = same?.category === 'todo' || same?.category === 'active' ? same : (firstOfCategory(after, s.category) ?? initialStatus(after));
      await store.moveOpenRequests(s.key, to, typeIds);
    }
  }


  async setArchived(id: string, archived: boolean): Promise<AssetType> {
    return this.store.setTypeArchived(id, archived);
  }

  templates(): TemplateSummary[] {
    return starterTemplates.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      icon: t.icon,
      color: t.color,
      fieldCount: t.fields.length,
      trackedDates: t.fields.filter((f) => f.tracking).map((f) => f.label),
    }));
  }

  /** Creates an ordinary, fully editable asset type from a starter template. */
  async createFromTemplate(templateKey: string): Promise<AssetType> {
    const template = starterTemplates.find((t) => t.key === templateKey);
    if (!template) throw AppError.notFound('Template');
    const kinds = await this.store.listDateKinds();
    const input = instantiateTemplate(template, new Map(kinds.map((k) => [k.key, k.id])));
    const existing = new Set((await this.store.listTypes(true)).map((t) => t.key));
    let key = input.key;
    for (let i = 2; existing.has(key); i++) key = `${input.key}_${i}`;
    return this.createType({ ...input, key, name: key === input.key ? input.name : `${input.name} (${key.split('_').pop()})` });
  }

  private async validated(input: AssetTypeInput): Promise<AssetTypeInput> {
    const parsed = assetTypeInputSchema.parse(input);
    const kinds = await this.store.listDateKinds();
    const issues = [
      ...validateTypeStructure(parsed, new Set(kinds.map((k) => k.id))),
      ...(parsed.requestWorkflow ? validateWorkflow(parsed.requestWorkflow).map((i) => ({ ...i, path: `requestWorkflow.${i.path}` })) : []),
      ...(await unknownResponsibleUnits(this.store, parsed.workflows ?? [])),
    ];
    if (issues.length) throw AppError.validation('The template has problems', { issues });
    return parsed;
  }
}

/** Every workflow's responsible unit must exist. */
export async function unknownResponsibleUnits(store: RegistryStore, workflows: Array<{ name: string; responsibleUnitId: string | null }>) {
  const issues: Array<{ path: string; message: string }> = [];
  for (const [i, w] of workflows.entries()) {
    if (!w.responsibleUnitId) continue;
    const u = await store.getUnit(w.responsibleUnitId);
    if (!u || u.archived) issues.push({ path: `workflows.${i}.responsibleUnitId`, message: `${w.name}: unknown or archived responsible unit` });
  }
  return issues;
}

/** Re-emits `asset.changed` for every asset of the given types or variants (after schema or kind changes). */
export async function republishAssets(store: RegistryStore, where: { typeIds?: string[]; variantIds?: string[] }): Promise<void> {
  const ids = [...(where.typeIds?.length ? await store.assetIdsOfTypes(where.typeIds) : []), ...(await Promise.all((where.variantIds ?? []).map((v) => store.assetIdsOfVariant(v)))).flat()];
  if (!ids.length) return;
  const kinds = new Map((await store.listDateKinds()).map((k) => [k.id, k]));
  const schemas = new Map<string, Awaited<ReturnType<typeof itemSchema>>>();
  for (const assetId of new Set(ids)) {
    await store.resplitAsset(assetId);
    const asset = await store.getAsset(assetId);
    if (!asset) continue;
    const key = `${asset.assetTypeId}|${asset.variantId ?? ''}`;
    if (!schemas.has(key)) schemas.set(key, await itemSchema(store, asset.assetTypeId, asset.variantId));
    const sch = schemas.get(key);
    if (sch) await store.publish('asset.changed', assetChangedEvent(asset, sch.schema, kinds));
  }
}
