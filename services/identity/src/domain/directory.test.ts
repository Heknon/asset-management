import { describe, expect, it } from 'bun:test';
import { orgPathOf, orgTag, ouPath, planUnits, suggestRules, type DirectoryPerson } from './directory.js';

/**
 * Acme: R&D (Platform, Mobile) and Sales. Dana heads R&D, Tom leads Platform,
 * Mia leads Mobile; Sam heads Sales. Ofer has no department in the directory.
 */
const dn = (cn: string, ...ous: string[]) => [`CN=${cn}`, ...ous.map((o) => `OU=${o}`), 'OU=Users', 'DC=acme', 'DC=com'].join(',');
function person(cn: string, attrs: Record<string, string>, manager: string | null, ous: string[]): DirectoryPerson {
  return {
    dn: dn(cn, ...ous),
    username: cn.toLowerCase(),
    displayName: cn,
    email: `${cn.toLowerCase()}@acme.com`,
    otherNames: [],
    groups: [],
    attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, [v]])),
    managerDn: manager,
  };
}
const ceo = person('Ceo', { company: 'Acme' }, null, []);
const dana = person('Dana', { company: 'Acme', division: 'R&D', department: 'R&D Management' }, ceo.dn, ['R&D']);
const tom = person('Tom', { company: 'Acme', division: 'R&D', department: 'Platform' }, dana.dn, ['Platform', 'R&D']);
const mia = person('Mia', { company: 'Acme', division: 'R&D', department: 'Mobile' }, dana.dn, ['Mobile', 'R&D']);
const platform = ['Avi', 'Ben', 'Gal'].map((n) => person(n, { company: 'Acme', division: 'R&D', department: 'Platform' }, tom.dn, ['Platform', 'R&D']));
const mobile = ['Lia', 'Noa'].map((n) => person(n, { company: 'Acme', division: 'R&D', department: 'Mobile' }, mia.dn, ['Mobile', 'R&D']));
const sam = person('Sam', { company: 'Acme', division: 'Sales', department: 'Sales' }, ceo.dn, ['Sales']);
const sales = ['Ron', 'Tal'].map((n) => person(n, { company: 'Acme', division: 'Sales', department: 'Sales' }, sam.dn, ['Sales']));
const ofer = person('Ofer', { company: 'Acme' }, ceo.dn, []);
const everyone = [ceo, dana, tom, mia, ...platform, ...mobile, sam, ...sales, ofer];

describe('directory import', () => {
  it('reads folders out of a DN, top first', () => {
    expect(ouPath('CN=Tom,OU=Platform,OU=R\\,D,OU=Users,DC=acme,DC=com')).toEqual(['Users', 'R,D', 'Platform']);
  });

  it('suggests company › division › department, and folders as another way', () => {
    const [best, ...rest] = suggestRules(everyone);
    expect(best!.rule).toEqual({ kind: 'attributes', attributes: ['company', 'division', 'department'] });
    expect(best!.placed).toBe(everyone.length);
    expect(rest.find((o) => o.rule.kind === 'ou')?.rule).toEqual({ kind: 'ou', skip: ['Users'] });
  });

  it('places people on paths, folding repeated levels and stopping at missing ones', () => {
    const rule = { kind: 'attributes' as const, attributes: ['company', 'division', 'department'] };
    expect(orgPathOf(rule, platform[0]!)).toEqual(['Acme', 'R&D', 'Platform']);
    // Sales › Sales is one level.
    expect(orgPathOf(rule, sales[0]!)).toEqual(['Acme', 'Sales']);
    expect(orgPathOf(rule, ofer)).toEqual(['Acme']);
    expect(orgTag(['Acme', 'R&D', 'Platform'])).toBe('org:Acme / R&D / Platform');
    expect(orgPathOf({ kind: 'ou', skip: ['Users'] }, tom)).toEqual(['R&D', 'Platform']);
    expect(orgPathOf({ kind: 'ou', skip: ['Staff'] }, tom)).toEqual([]);
  });

  it('plans units with their heads, leaving out what the directory does not say', () => {
    const { units, unplaced } = planUnits({ kind: 'ou', skip: ['Users'] }, everyone);
    const head = (path: string) => units.find((u) => u.path.join('/') === path)?.manager?.displayName ?? null;
    expect(units.map((u) => u.path.join('/'))).toEqual(['R&D', 'Sales', 'R&D/Mobile', 'R&D/Platform']);
    expect(head('R&D')).toBe('Dana');
    expect(head('R&D/Platform')).toBe('Tom');
    expect(head('R&D/Mobile')).toBe('Mia');
    expect(head('Sales')).toBe('Sam');
    // The CEO and Ofer sit in no folder below Users: placed by hand.
    expect(unplaced.map((p) => p.displayName).sort()).toEqual(['Ceo', 'Ofer']);
  });

  it('leaves out excluded branches', () => {
    const rule = { kind: 'attributes' as const, attributes: ['company', 'division', 'department'] };
    const { units, unplaced } = planUnits(rule, everyone, [['acme', 'sales']]);
    expect(units.some((u) => u.path.includes('Sales'))).toBe(false);
    expect(unplaced.map((p) => p.displayName)).toEqual(['Sam', 'Ron', 'Tal']);
  });
});
