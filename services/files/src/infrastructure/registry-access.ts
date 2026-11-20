import { AppError, type AccessCheck } from '@am/core';
import type { AssetAccess } from '../application/ports.js';

/** Forwards the caller's token to the registry, which owns asset authorisation. */
export class RegistryAssetAccess implements AssetAccess {
  /** `fetcher` reaches the registry: the network on the server, the in-process router in the browser. */
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async check(token: string, assetId: string): Promise<AccessCheck | null> {
    const res = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/api/registry/assets/${encodeURIComponent(assetId)}/access`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res) throw new AppError('unavailable', 'The asset registry is not reachable');
    if (res.status === 404 || res.status === 403) return null;
    if (res.status === 401) throw AppError.unauthenticated();
    if (!res.ok) throw new AppError('unavailable', 'The asset registry is not reachable');
    return (await res.json()) as AccessCheck;
  }
}
