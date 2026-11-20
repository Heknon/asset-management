import type { SearchHit } from '@am/core';
import { Building2, LayoutTemplate, ShoppingCart } from 'lucide-react';
import { useLookups } from '@/lib/queries';
import { TypeIcon } from './type-icon';
import { Avatar, IconTile } from './ui/display';

/** Where a hit opens. Shared by the palette and the results page. */
export function hitLink(h: SearchHit): { to: string; params?: Record<string, string>; search?: Record<string, string> } {
  switch (h.kind) {
    case 'asset':
      return { to: '/assets/$assetId', params: { assetId: h.id } };
    case 'request':
      return { to: '/requests/$requestId', params: { requestId: h.id } };
    case 'unit':
      return { to: '/units/$unitId', params: { unitId: h.id } };
    case 'type':
      return { to: '/assets', search: { type: h.id } };
    case 'person':
      return { to: '/assets', search: { q: h.title } };
  }
}

export function HitIcon({ hit, size = 28 }: { hit: SearchHit; size?: number }) {
  const { typeById, unitById } = useLookups();
  const type = hit.assetTypeId ? typeById.get(hit.assetTypeId) : hit.kind === 'type' ? typeById.get(hit.id) : undefined;
  if ((hit.kind === 'asset' || hit.kind === 'type') && type) return <TypeIcon icon={type.icon} color={type.color} size={size} />;
  if (hit.kind === 'person') return <Avatar name={hit.title} size={size} />;
  const color = hit.kind === 'unit' ? (unitById.get(hit.id)?.color ?? '#64748b') : '#64748b';
  return <IconTile color={color} size={size}>{hit.kind === 'unit' ? <Building2 /> : hit.kind === 'request' ? <ShoppingCart /> : <LayoutTemplate />}</IconTile>;
}

