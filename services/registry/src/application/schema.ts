import { formatReference, withVariant, type AssetType, type TypeVariant } from '@am/core';
import type { RegistryStore } from './ports.js';

/** What an item follows: its template plus its team variant's fields. */
export interface ItemSchema {
  type: AssetType;
  variant: TypeVariant | null;
  /** Template + the team's fields; still named after the template (a team's fields do not make it another kind of thing). */
  schema: AssetType;
}

export async function itemSchema(store: RegistryStore, assetTypeId: string, variantId: string | null | undefined): Promise<ItemSchema | null> {
  const type = await store.getType(assetTypeId);
  if (!type) return null;
  const variant = variantId ? await store.getVariant(variantId) : null;
  return { type, variant, schema: variant ? withVariant(type, variant) : type };
}

export const referenceOf = (type: Pick<AssetType, 'refPrefix'>, refNo: number) => formatReference(type.refPrefix, refNo);
