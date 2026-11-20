import type { IdentityStore, PasswordHasher, PasswordProvider } from '../application/ports.js';
import { normalizeUsername, type ExternalIdentity } from '../domain/model.js';

// ─── Local (break-glass) ─────────────────────────────────────────────────────

export class LocalPasswordProvider implements PasswordProvider {
  readonly info = { id: 'local' as const, label: 'Username and password', flow: 'password' as const };

  constructor(
    private readonly store: IdentityStore,
    private readonly hasher: PasswordHasher,
  ) {}

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    const user = await this.store.findUserByUsername(normalizeUsername(username), 'local');
    const hash = user ? await this.store.getPasswordHash(user.id) : null;
    // Always run a verification so response timing does not reveal whether the account exists.
    const ok = await this.hasher.verify(password, hash ?? DUMMY_HASH);
    if (!user || !hash || !ok || !user.active) return null;
    return { source: 'local', externalId: user.username, username: user.username, displayName: user.displayName, email: user.email, groups: [], tags: [], directoryAdmin: false };
  }
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
