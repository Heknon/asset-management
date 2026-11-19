import { parseOrgImport } from '@am/core';
import { describe, expect, it } from 'vitest';
import { assertValidParent, planImport, unitKey } from './domain/org.js';
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

describe('organization tree', () => {
  const wix = { id: 'w', name: 'Wix', path: ['w'], directoryMembers: [], directoryManagers: [], archived: false };
  const rnd = { id: 'r', name: 'R&D', path: ['w', 'r'], directoryMembers: ['CN=rnd'], directoryManagers: [], archived: false };

  it('refuses to move a unit under itself or its descendants', () => {
    expect(() => assertValidParent('w', rnd)).toThrow(/inside itself/);
    expect(() => assertValidParent('r', rnd)).toThrow(/inside itself/);
    expect(() => assertValidParent('x', rnd)).not.toThrow();
  });

  it('plans imports parents-first, reusing existing units and merging links', () => {
    const { rows } = parseOrgImport('Wix / R&D / Editor / Platform | department=Platform\nwix / r&d | CN=rnd-all');
    const steps = planImport(rows, [wix, rnd], ['Company', 'Division', 'Department', 'Team']);
    expect(steps.map((s) => [s.path.join('/'), s.existingId, s.kind, s.members])).toEqual([
      ['Wix', 'w', 'Company', []],
      ['Wix/R&D', 'r', 'Division', ['CN=rnd', 'CN=rnd-all']],
      ['Wix/R&D/Editor', null, 'Department', []],
      ['Wix/R&D/Editor/Platform', null, 'Team', ['department=Platform']],
    ]);
  });

  it('derives unique keys from paths', () => {
    expect(unitKey(['Wix', 'R&D', 'Editor'], new Set())).toBe('wix__r_d__editor');
    expect(unitKey(['Wix'], new Set(['wix']))).toBe('wix_2');
  });
});
