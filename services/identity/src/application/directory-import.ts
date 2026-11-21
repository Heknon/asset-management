import {
  AppError,
  orgUnitInputSchema,
  type DirectoryApply,
  type DirectoryApplyResult,
  type DirectoryPreview,
  type OrgRule,
  type OrgUnit,
} from '@am/core';
import { orgPathOf, orgTag, planUnits, suggestRules, type DirectoryPerson } from '../domain/directory.js';
import type { ExternalIdentity } from '../domain/model.js';
import { unitKey } from '../domain/org.js';
import type { OrgService } from './org-service.js';
import type { DirectoryCrawler, IdentityStore } from './ports.js';

export const ORG_RULE_KEY = 'org_rule';
const PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#f43f5e', '#14b8a6'];

/** The tag of where this person sits under the saved rule (applied at each sign-in), if any. */
export async function orgTagFor(store: IdentityStore, identity: Pick<ExternalIdentity, 'source' | 'externalId' | 'attributes'>): Promise<string | null> {
  if (identity.source !== 'ldap' || !identity.attributes) return null;
  const rule = await store.getSetting<OrgRule>(ORG_RULE_KEY);
  if (!rule) return null;
  const path = orgPathOf(rule, { dn: identity.externalId, attributes: identity.attributes });
  return path.length ? orgTag(path) : null;
}

/**
 * The directory import: read everyone, suggest how the company is organised,
 * show it, and on apply create the units (linked to their path, so sign-ins
 * keep people placed), an account for everyone, the heads the directory
 * names, and deactivate those who left. Run it again any time: it only adds
 * what is new and changes what moved.
 */
export class DirectoryImportService {
  /** The last crawl, so choosing another rule or applying does not read the directory again. */
  private recent: { at: number; people: DirectoryPerson[]; complete: boolean } | null = null;

  constructor(
    private readonly store: IdentityStore,
    private readonly org: OrgService,
    private readonly crawler: DirectoryCrawler | null,
    private readonly limit: number,
  ) {}

  get available() {
    return !!this.crawler;
  }

  private async crawl(fresh: boolean) {
    if (!this.crawler) throw AppError.validation('The directory import needs LDAP (Active Directory) sign-in to be set up');
    if (!fresh && this.recent && Date.now() - this.recent.at < 10 * 60_000) return this.recent;
    const r = await this.crawler.crawl(this.limit);
    this.recent = { at: Date.now(), ...r };
    return this.recent;
  }

  /** The existing unit for a path: one already linked to it, or one with the same names. */
  private matcher(units: OrgUnit[]) {
    const byId = new Map(units.map((u) => [u.id, u]));
    const names = (u: OrgUnit) => u.path.map((id) => byId.get(id)?.name.toLowerCase() ?? '').join('\u0000');
    const byNames = new Map(units.map((u) => [names(u), u]));
    const byTag = new Map(units.flatMap((u) => u.directoryMembers.map((l) => [l.toLowerCase(), u] as const)));
    return (path: string[]) => byTag.get(orgTag(path).toLowerCase()) ?? byNames.get(path.map((s) => s.toLowerCase()).join('\u0000')) ?? null;
  }

  async preview(rule?: OrgRule): Promise<DirectoryPreview> {
    const { people, complete } = await this.crawl(!rule);
    const options = suggestRules(people);
    const chosen = rule ?? (await this.store.getSetting<OrgRule>(ORG_RULE_KEY)) ?? options[0]?.rule ?? { kind: 'ou', skip: [] };
    const plan = planUnits(chosen, people);
    const find = this.matcher((await this.store.listUnits(true)).filter((u) => !u.archived));
    const accounts = await this.store.directoryAccounts('ldap');
    const known = new Set(accounts.map((a) => a.externalId?.toLowerCase()).filter(Boolean));
    const present = new Set(people.map((p) => p.dn.toLowerCase()));
    const leavers = complete ? accounts.filter((a) => a.active && a.externalId && !present.has(a.externalId.toLowerCase())) : [];
    return {
      people: people.length,
      complete,
      options,
      rule: chosen,
      units: plan.units.map((u) => ({
        path: u.path,
        people: u.people.length,
        existingId: find(u.path)?.id ?? null,
        manager: u.manager ? { name: u.manager.displayName, email: u.manager.email } : null,
      })),
      unplaced: { count: plan.unplaced.length, sample: plan.unplaced.slice(0, 50).map((p) => ({ name: p.displayName, email: p.email })) },
      users: {
        create: people.filter((p) => !known.has(p.dn.toLowerCase())).length,
        update: people.filter((p) => known.has(p.dn.toLowerCase())).length,
        deactivate: leavers.length,
        deactivateSample: leavers.slice(0, 20).map((a) => a.displayName),
      },
    };
  }

  async apply(input: DirectoryApply): Promise<DirectoryApplyResult> {
    const { people, complete } = await this.crawl(false);
    const plan = planUnits(input.rule, people, input.exclude);
    await this.store.putSetting(ORG_RULE_KEY, input.rule);
    const result: DirectoryApplyResult = { unitsCreated: 0, unitsLinked: 0, usersCreated: 0, usersUpdated: 0, usersDeactivated: 0, managersSet: 0, unplaced: plan.unplaced.length };

    // 1. Units, parents first: linked to their path, created when missing.
    const units = await this.store.listUnits(true);
    // Archived units are not reused (people would land in a unit nobody sees); their keys stay taken.
    const find = this.matcher(units.filter((u) => !u.archived));
    const taken = new Set(units.map((u) => u.key));
    const unitOf = new Map<string, string>();
    const touched: string[] = [];
    for (const [i, u] of plan.units.entries()) {
      const tag = orgTag(u.path);
      const parentId = u.path.length > 1 ? (unitOf.get(u.path.slice(0, -1).join('\u0000').toLowerCase()) ?? null) : null;
      const existing = find(u.path);
      let id: string;
      if (existing) {
        id = existing.id;
        if (!existing.directoryMembers.some((l) => l.toLowerCase() === tag.toLowerCase())) {
          const { id: _i, path: _p, memberCount: _m, managerCount: _c, ...rest } = existing;
          await this.org.update(existing.id, orgUnitInputSchema.parse({ ...rest, directoryMembers: [...existing.directoryMembers, tag].slice(0, 50) }));
          result.unitsLinked++;
        }
      } else {
        const key = unitKey(u.path, taken);
        taken.add(key);
        const created = await this.org.create(
          orgUnitInputSchema.parse({
            key,
            name: u.path.at(-1)!,
            kind: input.kinds[Math.min(u.path.length - 1, input.kinds.length - 1)] ?? 'Team',
            parentId,
            color: PALETTE[i % PALETTE.length],
            memberRole: 'viewer',
            directoryMembers: [tag],
          }),
        );
        id = created.id;
        result.unitsCreated++;
      }
      unitOf.set(u.path.join('\u0000').toLowerCase(), id);
      touched.push(id);
    }

    // 2. An account for everyone, tagged with where they sit (sign-in keeps the tag up to date).
    const accounts = await this.store.directoryAccounts('ldap');
    const known = new Set(accounts.map((a) => a.externalId?.toLowerCase()).filter(Boolean));
    const userOf = new Map<string, string>();
    for (const p of people) {
      const path = orgPathOf(input.rule, p);
      const placed = path.length && !plan.unplaced.includes(p);
      const tags = [...(p.tags ?? []), ...(placed ? [orgTag(path)] : [])];
      const user = await this.store.transaction(async (tx) => {
        const u = await tx.upsertUserFromIdentity({
          source: 'ldap',
          externalId: p.dn,
          username: p.username,
          displayName: p.displayName,
          email: p.email,
          otherNames: p.otherNames,
          groups: p.groups,
          tags,
          directoryAdmin: p.directoryAdmin ?? false,
        });
        await tx.syncExternalGroups(u.id, 'ldap', p.groups);
        await tx.publishUserChanged(u);
        return u;
      });
      userOf.set(p.dn.toLowerCase(), user.id);
      if (known.has(p.dn.toLowerCase())) result.usersUpdated++;
      else result.usersCreated++;
    }

    // 3. Who belongs where follows the links, now that everyone has their tag.
    // Units linked to a path the directory no longer has are re-synced too: their people moved on.
    for (const u of units) if (!touched.includes(u.id) && u.directoryMembers.some((l) => l.toLowerCase().startsWith('org:'))) touched.push(u.id);
    await this.store.transaction(async (tx) => {
      for (const id of touched) await tx.syncUnitDirectory(id);
    });

    // 4. Heads the directory names: managers of their units (added, never taken away).
    if (input.managers) {
      for (const u of plan.units) {
        const headId = u.manager ? userOf.get(u.manager.dn.toLowerCase()) : undefined;
        const unitId = unitOf.get(u.path.join('\u0000').toLowerCase());
        if (!headId || !unitId) continue;
        const current = await this.store.unitPeople(unitId);
        const manual = current.filter((x) => x.source === 'manual');
        if (current.some((x) => x.id === headId && x.role === 'manager')) continue;
        await this.store.transaction((tx) =>
          tx.setManualPeople(
            unitId,
            manual.filter((x) => x.role === 'member' && x.id !== headId).map((x) => x.id),
            [...manual.filter((x) => x.role === 'manager').map((x) => x.id), headId],
          ),
        );
        result.managersSet++;
      }
    }

    // 5. Leavers: accounts no longer in the directory are deactivated (never deleted: their items keep their history).
    if (input.deactivateLeavers && complete) {
      const present = new Set(people.map((p) => p.dn.toLowerCase()));
      for (const a of accounts) {
        if (!a.active || !a.externalId || present.has(a.externalId.toLowerCase())) continue;
        await this.store.transaction(async (tx) => {
          const u = await tx.updateUser(a.id, { active: false });
          await tx.revokeUserSessions(a.id);
          await tx.publishUserChanged(u);
        });
        result.usersDeactivated++;
      }
    }

    await this.store.transaction((tx) => tx.publishUnitChanged(touched));
    return result;
  }
}
