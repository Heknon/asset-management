import { describe, expect, it } from 'vitest';
import { normalizeUsername } from './domain/model.js';
import { safeReturnTo } from './http/routes.js';
import { ScryptHasher } from './infrastructure/crypto.js';
import { groupNameFrom } from './infrastructure/pg-identity-store.js';
import { escapeLdapFilter } from './infrastructure/providers.js';

describe('identity', () => {
  it('escapes LDAP filter metacharacters (no injection via username)', () => {
    expect(escapeLdapFilter('*)(uid=*))(|(uid=*')).toBe('\\2a\\29\\28uid=\\2a\\29\\29\\28|\\28uid=\\2a');
    expect(escapeLdapFilter('a\\b\u0000')).toBe('a\\5cb\\00');
  });

  it('normalises DOMAIN\\user and case', () => {
    expect(normalizeUsername('  CORP\\JDoe ')).toBe('jdoe');
    expect(normalizeUsername('jane.doe@corp.example')).toBe('jane.doe@corp.example');
  });

  it('only allows same-site relative return paths', () => {
    expect(safeReturnTo('/assets/1?x=1')).toBe('/assets/1?x=1');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });

  it('derives readable names from group DNs', () => {
    expect(groupNameFrom('CN=Finance Buyers,OU=Groups,DC=corp,DC=example')).toBe('Finance Buyers');
    expect(groupNameFrom('Asset Admins')).toBe('Asset Admins');
  });

  it('hashes and verifies passwords', async () => {
    const h = new ScryptHasher();
    const hash = await h.hash('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await h.verify('correct horse battery staple', hash)).toBe(true);
    expect(await h.verify('wrong', hash)).toBe(false);
    expect(await h.verify('x', 'garbage')).toBe(false);
  });
});
