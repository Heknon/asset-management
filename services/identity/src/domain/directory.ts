import type { DirectoryRuleOption, OrgRule } from '@am/core';

/**
 * Reading an org tree out of the directory, without anyone typing it in.
 * Pure: the crawler hands over people, this suggests how to group them,
 * places each person on a path, and suggests each unit's head.
 */

/** One person as the directory describes them. */
export interface DirectoryPerson {
  dn: string;
  username: string;
  displayName: string;
  email: string | null;
  otherNames: string[];
  groups: string[];
  /** Attributes that can describe where someone sits: company, division, department, … */
  attributes: Record<string, string[]>;
  /** DN of the person's manager, when the directory says. */
  managerDn: string | null;
  /** Tags the sign-in gives them too (configured unit attributes, `department=Platform`). */
  tags?: string[];
  /** In a configured administrators group. */
  directoryAdmin?: boolean;
}

/** Attributes worth trying, in no particular order; the directory decides which ones it fills. */
export const orgAttributeCandidates = ['company', 'division', 'department', 'departmentNumber', 'businessCategory', 'o', 'ou'] as const;

const clean = (v: string | undefined) => v?.replace(/\s+/g, ' ').trim() || undefined;

/** The folders (OUs) of a DN, top first: CN=Tom,OU=Platform,OU=R&D,DC=corp → [R&D, Platform]. */
export function ouPath(dn: string): string[] {
  const parts = dn.split(/,(?=\s*[A-Za-z]+=)/).map((p) => p.trim());
  return parts
    .filter((p) => /^ou=/i.test(p))
    .map((p) => p.slice(3).replace(/\\(.)/g, '$1').trim())
    .reverse();
}

/** Where this person sits under a rule; empty when the directory does not say. */
export function orgPathOf(rule: OrgRule, p: Pick<DirectoryPerson, 'dn' | 'attributes'>): string[] {
  if (rule.kind === 'ou') {
    const path = ouPath(p.dn);
    const skip = rule.skip.map((s) => s.toLowerCase());
    let i = 0;
    while (i < skip.length && path[i]?.toLowerCase() === skip[i]) i++;
    return i === skip.length ? path.slice(i) : [];
  }
  const path: string[] = [];
  for (const a of rule.attributes) {
    const v = clean(p.attributes[a]?.[0]);
    // A missing level ends the path: a department without its division is not guessed.
    if (!v) break;
    // The same value twice in a row (company "Acme", o "Acme") is one level.
    if (path.at(-1)?.toLowerCase() !== v.toLowerCase()) path.push(v);
  }
  return path;
}

/** The tag everyone on a path carries, and the link that places them in its unit. */
export const orgTag = (path: readonly string[]) => `org:${path.join(' / ')}`;

export const ruleLabel = (rule: OrgRule) => (rule.kind === 'ou' ? 'Folders (OU)' : rule.attributes.join(' › '));

/**
 * The ways this directory could be grouped, best first. Attributes are
 * ordered from broad to narrow by how many values they have, keeping only
 * those that most people have and that add a level.
 */
export function suggestRules(people: readonly DirectoryPerson[]): DirectoryRuleOption[] {
  const n = people.length || 1;
  const options: DirectoryRuleOption[] = [];

  const stats = orgAttributeCandidates
    .map((a) => {
      const values = people.map((p) => clean(p.attributes[a]?.[0])?.toLowerCase()).filter((v): v is string => !!v);
      return { a, coverage: values.length / n, distinct: new Set(values).size };
    })
    .filter((s) => s.coverage >= 0.3 && s.distinct >= 1)
    .sort((x, y) => x.distinct - y.distinct || y.coverage - x.coverage);
  // Drop attributes that repeat a broader one (department and departmentNumber with the same split).
  const chosen: string[] = [];
  for (const s of stats) {
    const prev = chosen.at(-1);
    if (prev) {
      const pairs = new Set(people.map((p) => `${clean(p.attributes[prev]?.[0])?.toLowerCase()}\u0000${clean(p.attributes[s.a]?.[0])?.toLowerCase()}`));
      const prevValues = new Set(people.map((p) => clean(p.attributes[prev]?.[0])?.toLowerCase()));
      if (pairs.size <= prevValues.size) continue;
    }
    // A single-valued attribute is only useful at the top (the company).
    if (s.distinct === 1 && chosen.length) continue;
    chosen.push(s.a);
  }
  // A lone company-wide value says nothing; it needs a level beneath it.
  const meaningful = chosen.length > 1 || stats.find((s) => s.a === chosen[0])?.distinct !== 1;
  if (chosen.length && meaningful) options.push(measure({ kind: 'attributes', attributes: chosen.slice(0, 5) }, people));
  // Single attributes, for directories where only one of them is any good.
  for (const s of stats.filter((s) => s.distinct > 1)) {
    if (chosen.length === 1 && chosen[0] === s.a) continue;
    options.push(measure({ kind: 'attributes', attributes: [s.a] }, people));
  }

  // Folders: skip the ones everyone shares (OU=Users, OU=Employees).
  const paths = people.map((p) => ouPath(p.dn)).filter((p) => p.length);
  if (paths.length / n >= 0.3) {
    const skip: string[] = [];
    for (let i = 0; ; i++) {
      const v = paths[0]![i];
      // Shared by everyone, with someone deeper (people sitting right in it are placed by hand).
      if (!v || !paths.every((p) => p[i]?.toLowerCase() === v.toLowerCase()) || !paths.some((p) => p.length > i + 1)) break;
      skip.push(v);
    }
    const ou = measure({ kind: 'ou', skip }, people);
    if (ou.units > 1) options.push(ou);
  }
  // Most people placed (within 2% counts as a tie), then attributes (they name units as people say them), then deeper trees.
  const near = (a: DirectoryRuleOption, b: DirectoryRuleOption) => Math.abs(a.placed - b.placed) <= n * 0.02;
  return options.sort(
    (a, b) =>
      (near(a, b) ? 0 : b.placed - a.placed) ||
      (a.rule.kind === b.rule.kind ? 0 : a.rule.kind === 'attributes' ? -1 : 1) ||
      Math.min(b.depth, 4) - Math.min(a.depth, 4) ||
      a.units - b.units,
  );
}

function measure(rule: OrgRule, people: readonly DirectoryPerson[]): DirectoryRuleOption {
  const units = new Set<string>();
  let placed = 0;
  let depth = 0;
  for (const p of people) {
    const path = orgPathOf(rule, p);
    if (!path.length) continue;
    placed++;
    depth = Math.max(depth, path.length);
    for (let i = 1; i <= path.length; i++) units.add(path.slice(0, i).join('\u0000').toLowerCase());
  }
  return { rule, label: ruleLabel(rule), placed, units: units.size, depth };
}

export interface PlannedUnit {
  path: string[];
  /** People placed directly here. */
  people: DirectoryPerson[];
  /** Suggested head, when most of the unit reports to the same person. */
  manager: DirectoryPerson | null;
}

const pathKey = (path: readonly string[]) => path.map((s) => s.toLowerCase()).join('\u0000');

/** The units a rule makes (parents included, parents first), with their people and suggested heads. */
export function planUnits(rule: OrgRule, people: readonly DirectoryPerson[], exclude: ReadonlyArray<readonly string[]> = []): { units: PlannedUnit[]; unplaced: DirectoryPerson[] } {
  const excluded = (path: readonly string[]) => exclude.some((x) => x.length <= path.length && x.every((s, i) => s.toLowerCase() === path[i]!.toLowerCase()));
  const units = new Map<string, PlannedUnit>();
  const unplaced: DirectoryPerson[] = [];
  for (const p of people) {
    const path = orgPathOf(rule, p);
    if (!path.length || excluded(path)) {
      unplaced.push(p);
      continue;
    }
    for (let i = 1; i <= path.length; i++) {
      const sub = path.slice(0, i);
      const k = pathKey(sub);
      if (!units.has(k)) units.set(k, { path: sub, people: [], manager: null });
    }
    units.get(pathKey(path))!.people.push(p);
  }
  const byDn = new Map(people.map((p) => [p.dn.toLowerCase(), p]));
  for (const u of units.values()) u.manager = suggestHead(u, units, byDn);
  return { units: [...units.values()].sort((a, b) => a.path.length - b.path.length || a.path.join('/').localeCompare(b.path.join('/'))), unplaced };
}

/**
 * The unit's head: the person whose reporting line covers the most of the
 * unit (with everything beneath it), at least 60% of it, and the lowest of
 * those who cover as much, sitting in the unit or just above it. A department's people report to its head, directly or
 * through team leads; a division's report up to the division head. When the
 * directory does not say clearly, nobody: a person can be added by hand.
 */
function suggestHead(u: PlannedUnit, units: ReadonlyMap<string, PlannedUnit>, byDn: ReadonlyMap<string, DirectoryPerson>): DirectoryPerson | null {
  const prefix = pathKey(u.path);
  const within = (k: string) => k === prefix || k.startsWith(`${prefix}\u0000`);
  const inside: DirectoryPerson[] = [];
  for (const [k, x] of units) if (within(k)) inside.push(...x.people);
  if (!inside.length) return null;
  const chain = (p: DirectoryPerson) => {
    const out: string[] = [];
    let cur = p.managerDn?.toLowerCase();
    while (cur && out.length < 25 && !out.includes(cur)) {
      out.push(cur);
      cur = byDn.get(cur)?.managerDn?.toLowerCase();
    }
    return out;
  };
  // How many of the unit each person leads (themselves included).
  const covers = new Map<string, number>();
  for (const p of inside) for (const dn of [p.dn.toLowerCase(), ...chain(p)]) covers.set(dn, (covers.get(dn) ?? 0) + 1);
  const unitOf = new Map<DirectoryPerson, string>();
  for (const [k, x] of units) for (const p of x.people) unitOf.set(p, k);
  const parent = pathKey(u.path.slice(0, -1));
  let best: { person: DirectoryPerson; depth: number; count: number } | null = null;
  for (const [dn, count] of covers) {
    if (count < Math.max(1, Math.ceil(inside.length * 0.6))) continue;
    const person = byDn.get(dn);
    if (!person) continue;
    const at = unitOf.get(person);
    if (at !== undefined && !within(at) && at !== parent) continue;
    // Whoever leads the most of the unit; among equals, the lowest (the longest line above them).
    const depth = chain(person).length;
    if (!best || count > best.count || (count === best.count && depth > best.depth)) best = { person, depth, count };
  }
  // One person alone in a unit does not head it by default.
  return best && (inside.length > 1 || best.person !== inside[0]) ? best.person : null;
}
