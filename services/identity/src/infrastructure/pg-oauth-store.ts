import { sql, type Kysely } from 'kysely';
import type { OAuthClient, OAuthCode, OAuthStore } from '../application/oauth-service.js';
import type { IdentityDB } from './schema.js';

export class PgOAuthStore implements OAuthStore {
  constructor(private readonly db: Kysely<IdentityDB>) {}

  async createClient(client: OAuthClient): Promise<void> {
    await this.db.insertInto('oauth_clients').values({ id: client.id, name: client.name, redirect_uris: JSON.stringify(client.redirectUris) }).execute();
  }

  async findClient(id: string): Promise<OAuthClient | null> {
    const row = await this.db.selectFrom('oauth_clients').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? { id: row.id, name: row.name, redirectUris: row.redirect_uris } : null;
  }

  async createCode(codeHash: string, c: Omit<OAuthCode, 'usedAt'>): Promise<void> {
    // Old codes go as new ones arrive; they are only ever valid for minutes.
    await this.db.deleteFrom('oauth_codes').where('expires_at', '<', sql<Date>`now() - interval '1 hour'`).execute();
    await this.db
      .insertInto('oauth_codes')
      .values({ code_hash: codeHash, client_id: c.clientId, user_id: c.userId, redirect_uri: c.redirectUri, code_challenge: c.codeChallenge, resource: c.resource, scope: c.scope, expires_at: c.expiresAt })
      .execute();
  }

  async consumeCode(codeHash: string): Promise<OAuthCode | null> {
    const row = await this.db.updateTable('oauth_codes').set({ used_at: sql`now()` }).where('code_hash', '=', codeHash).where('used_at', 'is', null).returningAll().executeTakeFirst();
    return row
      ? { clientId: row.client_id, userId: row.user_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, resource: row.resource, scope: row.scope, expiresAt: new Date(row.expires_at), usedAt: row.used_at ? new Date(row.used_at) : null }
      : null;
  }
}
