/**
 * A realistic, large demo organisation, created through the public APIs (so
 * every rule, event and index applies): a company tree of ~200 units, people
 * with team memberships and managers, Procurement and Finance roles, ~400
 * assets across teams, requests at every stage, catalogs, a renewal check and
 * a team variant. Deterministic, and safe to run again (it skips what exists).
 *
 * Runs against a server (scripts/seed-demo.ts) or inside the browser runtime
 * ("Load the demo company" on the sign-in page).
 */

// API payloads are loosely typed fixture data here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** One signed-in API session. */
export type Call = <T = Json>(method: string, path: string, body?: unknown) => Promise<T>;

export interface SeedEnvironment {
  admin: { username: string; password: string };
  login(username: string, password: string): Promise<Call>;
  /** Waits until events from earlier calls are processed (projections caught up). */
  settle(): Promise<void>;
  log(message: string): void;
}

/** Every demo account's password (local accounts; production uses LDAP / ADFS). */
export const DEMO_PASSWORD = 'password-1234';

export const demoPersonas = [
  { username: 'dana.cohen', role: 'Procurement lead: handles every request, manages templates' },
  { username: 'tom.levi', role: 'Platform team member: owns licenses, asks for things' },
  { username: 'rachel.amar', role: 'R&D division head: manages R&D, shares catalogs' },
  { username: 'noa.mizrahi', role: 'Finance: sees company-wide spend' },
];

export async function seedDemo(env: SeedEnvironment): Promise<void> {
  // Deterministic randomness, so every run produces the same demo.
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = <T>(a: T[]): T => a[Math.floor(random() * a.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const admin = await env.login(env.admin.username, env.admin.password);
    const login = (username: string) => env.login(username, DEMO_PASSWORD);

  // ─── Organization ────────────────────────────────────────────────────────────
  const org = {
    'R&D': {
      Editor: ['Platform', 'Velo', 'Editor UX', 'Mobile Editor'],
      'Data & AI': ['BI', 'Data Platform', 'ML Infra', 'AI Assistants'],
      Infrastructure: ['SRE', 'Security', 'Developer Experience', 'Networking', 'Databases'],
      'Business Solutions': ['Stores', 'Bookings', 'Restaurants', 'Events', 'Payments'],
      'Client Platform': ['Web Performance', 'Design System', 'Accessibility'],
    },
    Marketing: { Brand: ['Creative Studio', 'Video'], Growth: ['SEO', 'Paid Acquisition', 'Lifecycle'], 'Product Marketing': ['Editor PMM', 'Business PMM'] },
    'Customer Care': { Support: ['Tier 1 EMEA', 'Tier 1 Americas', 'Tier 2'], 'Partner Success': ['Agencies', 'Enterprise'] },
    Sales: { EMEA: ['UK & Ireland', 'DACH', 'France', 'Nordics'], Americas: ['US East', 'US West', 'LATAM'], APAC: ['Japan', 'ANZ', 'SEA'] },
    Finance: { Procurement: ['Software Buying', 'Hardware & Facilities'], 'FP&A': ['Planning'], Accounting: ['Payables'] },
    People: { 'IT Support': ['Service Desk', 'End-User Devices'], Recruiting: ['Tech Recruiting'], Workplace: ['Tel Aviv Office', 'New York Office', 'Vilnius Office'] },
  };
  const lines = ['Wix'];
  for (const [division, depts] of Object.entries(org) as Array<[string, Record<string, string[]>]>) {
    lines.push(`Wix / ${division} | CN=${division.toLowerCase().replace(/\W+/g, '-')},OU=Groups,DC=wix,DC=com`);
    for (const [dept, teams] of Object.entries(depts)) {
      lines.push(`Wix / ${division} / ${dept} | department=${dept}`);
      for (const team of teams) lines.push(`Wix / ${division} / ${dept} / ${team} | CN=${team.toLowerCase().replace(/\W+/g, '-')},OU=Teams,DC=wix,DC=com`);
    }
  }
  // Sales has many small account squads — the long tail of a big org.
  for (const [region, countries] of Object.entries(org.Sales)) for (const country of countries) for (const s of ['Self-serve', 'Enterprise', 'Agencies']) lines.push(`Wix / Sales / ${region} / ${country} / ${country} ${s}`);
  for (const [dept, deptTeams] of Object.entries(org['R&D'])) for (const team of deptTeams) for (const s of ['Squad A', 'Squad B']) lines.push(`Wix / R&D / ${dept} / ${team} / ${team} ${s}`);
  const imported: Json = await admin('POST', '/api/identity/units/import', { text: lines.join('\n'), kinds: ['Company', 'Division', 'Department', 'Team', 'Squad'] });
  env.log(`org chart: ${imported.created} created, ${imported.updated} updated`);
  const units: Json[] = await admin('GET', '/api/identity/units');
  const byName = (name: string): Json => units.find((u: Json) => u.name === name);
  const teams: Json[] = units.filter((u: Json) => u.kind === 'Team');

  // ─── People ──────────────────────────────────────────────────────────────────
  const first = ['Dana', 'Tom', 'Rachel', 'Noa', 'Avi', 'Maya', 'Yoni', 'Tamar', 'Eitan', 'Shira', 'Omer', 'Lior', 'Gal', 'Roni', 'Itai', 'Michal', 'Ben', 'Sarah', 'David', 'Emma', 'Lucas', 'Sofia', 'Ivan', 'Ana', 'Kenji', 'Aiko', 'Liam', 'Chloe', 'Mateo', 'Zoe'];
  const last = ['Cohen', 'Levi', 'Amar', 'Mizrahi', 'Peretz', 'Biton', 'Friedman', 'Shapiro', 'Katz', 'Klein', 'Novak', 'Silva', 'Tanaka', 'Murphy', 'Schmidt', 'Rossi', 'Dubois', 'Kowalski', 'Jensen', 'Garcia'];
  const people: Json[] = [];
  const existingUsers = new Set((await admin('GET', '/api/identity/users?limit=500')).items.map((u: Json) => u.username));
  for (let i = 0; i < 60; i++) {
    const displayName = i < first.length ? `${first[i]} ${last[i % last.length]}` : `${pick(first)} ${pick(last)}`;
    const username = displayName.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '') + (i >= first.length ? i : '');
    if (!existingUsers.has(username)) await admin('POST', '/api/identity/users', { username, displayName, email: `${username}@example.local`, password: DEMO_PASSWORD });
    people.push({ username, displayName });
  }
  const users: Json[] = (await admin('GET', '/api/identity/users?limit=500')).items;
  const idOf = (username: string): string => users.find((u: Json) => u.username === username).id;

  // Personas for the demo.
  const dana = idOf('dana.cohen'); // Procurement lead: handles every request
  const tom = idOf('tom.levi'); // Platform team member
  const rachel = idOf('rachel.amar'); // R&D division head
  const noa = idOf('noa.mizrahi'); // Finance: views company-wide spend
  const membership = new Map<string, { members: string[]; managers: string[] }>(); // unitId -> { members, managers }
  const add = (unit: Json, role: 'members' | 'managers', id: string) => {
    const m = membership.get(unit.id) ?? { members: [], managers: [] };
    m[role].push(id);
    membership.set(unit.id, m);
  };
  add(byName('Platform'), 'members', tom);
  add(byName('R&D'), 'managers', rachel);
  add(byName('Software Buying'), 'members', dana);
  add(byName('Procurement'), 'managers', dana);
  add(byName('FP&A'), 'members', noa);
  const rest = users.filter((u: Json) => ![dana, tom, rachel, noa].includes(u.id) && u.username !== env.admin.username);
  rest.forEach((u: Json, i: number) => add(teams[i % teams.length], i % 9 === 0 ? 'managers' : 'members', u.id));
  for (const d of units.filter((u: Json) => u.kind === 'Division' && u.name !== 'R&D')) add(d, 'managers', rest[int(0, rest.length - 1)].id);
  for (const [unitId, m] of membership) await admin('PUT', `/api/identity/units/${unitId}/people`, m);
  env.log(`people: ${users.length} accounts, ${membership.size} units staffed`);

  // Company-wide roles beyond the org chart.
  const orgAccess = await admin('GET', '/api/identity/access');
  const grant = async (subject: { kind: string; id: string }, role: string) => {
    if (!orgAccess.grants.some((g: Json) => g.subject.kind === subject.kind && g.subject.id === subject.id))
      await admin('POST', '/api/identity/grants', { subject, unitId: null, assetTypeId: null, access: { role } });
  };
  await grant({ kind: 'user', id: dana }, 'admin'); // Procurement: manages templates, handles every request
  await grant({ kind: 'user', id: noa }, 'viewer');

  // ─── Templates ───────────────────────────────────────────────────────────────
  const types: Record<string, Json> = {};
  const current = await admin('GET', '/api/registry/asset-types');
  for (const key of ['software_license', 'sim_line', 'hardware', 'domain_certificate']) types[key] = current.find((t: Json) => t.key === key) ?? (await admin('POST', `/api/registry/templates/${key}/instantiate`));
  await env.settle(); // projections catch up (units, people)
  // Procurement is responsible for purchases: it handles every request and renews; other teams ask.
  await admin('PUT', '/api/registry/workflows/purchase-unit', { unitId: byName('Procurement').id });

  // ─── Assets ──────────────────────────────────────────────────────────────────
  const saas: Array<[string, string, number]> = [
    ['GitHub Enterprise', 'GitHub', 21], ['Datadog Pro', 'Datadog', 23], ['Figma Organization', 'Figma', 45], ['Slack Enterprise Grid', 'Slack', 15], ['Atlassian Cloud', 'Atlassian', 14],
    ['Miro Business', 'Miro', 10], ['Notion Plus', 'Notion', 8], ['Zoom Business', 'Zoom', 13], ['Adobe Creative Cloud', 'Adobe', 85], ['Salesforce Sales Cloud', 'Salesforce', 150],
    ['HubSpot Marketing Hub', 'HubSpot', 90], ['Snowflake Capacity', 'Snowflake', 2000], ['Tableau Creator', 'Tableau', 75], ['PagerDuty Business', 'PagerDuty', 41], ['1Password Business', '1Password', 8],
    ['Okta Workforce', 'Okta', 6], ['Zendesk Suite', 'Zendesk', 115], ['Gong', 'Gong', 120], ['Loom Business', 'Loom', 15], ['Postman Enterprise', 'Postman', 49],
    ['Sentry Business', 'Sentry', 80], ['LaunchDarkly Pro', 'LaunchDarkly', 20], ['Grammarly Business', 'Grammarly', 15], ['DocuSign Business', 'DocuSign', 40], ['Lucid Team', 'Lucid', 9],
  ];
  const have = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const page = await admin('GET', `/api/registry/assets?limit=500&offset=${offset}`);
    page.items.forEach((a: Json) => have.add(a.name));
    if (page.items.length < 500) break;
  }
  const assets: Array<[string, Json, string, Record<string, unknown>]> = [];
  for (let i = 0; i < 220; i++) {
    const [product, vendor, perSeat] = pick(saas);
    const team = pick(teams);
    const seats = int(3, 120);
    assets.push(['software_license', team, `${product} — ${team.name}`, { vendor, seats, cost_per_term: seats * perSeat * 12, term_months: pick([12, 12, 12, 24, 36]), notice_days: pick([30, 30, 60, 90]), auto_renews: random() > 0.4, renewal_date: day(int(-20, 400)), start_date: day(int(-900, -30)), portal_url: `https://${vendor.toLowerCase()}.com` }]);
  }
  for (const [product, vendor, perSeat] of saas.slice(0, 10)) assets.push(['software_license', byName('Wix'), `${product} — company-wide`, { vendor, seats: int(500, 6000), cost_per_term: int(500, 6000) * perSeat * 12, term_months: 12, notice_days: 90, auto_renews: true, renewal_date: day(int(10, 360)) }]);
  const carriers = ['Verizon', 'T-Mobile', 'Vodafone', 'Partner', 'Cellcom', 'O2'];
  for (let i = 0; i < 90; i++) {
    const team = pick(units.filter((u: Json) => u.path.length >= 4));
    const assignee = pick(users).id;
    assets.push(['sim_line', team, `Mobile line ${String(1000 + i)}`, { msisdn: `+1 415 555 ${String(1000 + i).slice(-4)}`, iccid: `89012601${String(10_000_000_000 + i * 7919).slice(0, 11)}`, carrier: pick(carriers), plan: pick(['voice_data', 'data_only', 'voice_only', 'iot']), monthly_cost: pick([12, 25, 35, 45, 60]), contract_end: day(int(-30, 500)), assignee }]);
  }
  const devices: Array<[string, number]> = [['MacBook Pro 16"', 3999], ['MacBook Air 13"', 1499], ['Dell XPS 15', 2299], ['ThinkPad X1 Carbon', 1899], ['Studio Display', 1599], ['iPhone 15', 999]];
  for (let i = 0; i < 80; i++) {
    const [model, price] = pick(devices);
    const team = pick(teams);
    assets.push(['hardware', team, `${model} #${String(i + 1).padStart(3, '0')}`, { serial: `C02${String(i * 104729).padStart(7, '0')}XR`, model, assignee: pick(users).id, purchase_price: price, purchase_date: day(int(-1000, -10)), warranty_end: day(int(-60, 700)) }]);
  }
  for (const [fqdn, registrar] of <Array<[string, string]>>[['wix.com', 'MarkMonitor'], ['*.wixsite.com', 'DigiCert'], ['editorx.com', 'MarkMonitor'], ['*.wixstatic.com', 'DigiCert'], ['wix-bookings.com', 'Gandi'], ['velo.dev', 'Gandi']])
    assets.push(['domain_certificate', byName('Infrastructure'), fqdn, { fqdn, registrar, annual_cost: int(40, 900), expires_on: day(int(5, 300)) }]);

  let created = 0;
  for (const [type, unit, name, attributes] of assets) {
    if (have.has(name)) continue;
    const owner = membership.get(unit.id)?.members[0] ?? membership.get(unit.id)?.managers[0] ?? null;
    await admin('POST', '/api/registry/assets', { assetTypeId: types[type].id, unitId: unit.id, name, ownerId: owner, attributes });
    created++;
  }
  env.log(`assets: ${created} created (${assets.length} in the demo set)`);

  // ─── Requests ────────────────────────────────────────────────────────────────
  const existingRequests = await admin('GET', '/api/registry/requests?scope=all&status=all&limit=1');
  if (existingRequests.total === 0) {
    const asTom = await login('tom.levi');
    const asRachel = await login('rachel.amar');
    const asDana = await login('dana.cohen');
    const platform = byName('Platform');
    const ideas: Array<[Call, Json, string, string, number | null, number, string | null]> = [
      [asTom, platform, 'Miro seats for the Platform team', 'We plan quarterly roadmaps in Miro; 10 of us need edit access.', 10, 1200, types.software_license.id],
      [asTom, byName('Editor'), 'Load-testing tool for the Editor department', 'k6 Cloud or similar; we keep hitting limits of our self-hosted setup.', null, 18000, types.software_license.id],
      [asTom, byName('Wix'), 'Company-wide password manager rollout', 'Security asked every team to move to a shared vault.', 5000, 240000, types.software_license.id],
      [asRachel, byName('R&D'), 'GPU capacity for the AI Assistants team', 'Reserved instances for model fine-tuning, 12 months.', null, 420000, null],
      [asRachel, byName('Data & AI'), 'Snowflake capacity top-up', 'We are at 85% of the annual commit.', null, 150000, types.software_license.id],
      [asTom, platform, 'Two Studio Displays for new hires', 'Starting next month.', 2, 3200, types.hardware.id],
    ];
    const made: Json[] = [];
    for (const [who, unit, title, description, quantity, amount, assetTypeId] of ideas) {
      made.push(await who('POST', '/api/registry/requests', { title, description, unitId: unit.id, quantity, estimatedCost: { amount, currency: 'USD' }, neededBy: day(int(10, 60)), assetTypeId }));
    }
    const act = (r: Json, body: Json) => asDana('POST', `/api/registry/requests/${r.id}/actions`, body);
    await act(made[1], { action: 'status', status: 'in_review' });
    await act(made[1], { action: 'comment', body: 'Do you have a quote from k6? I can also check our Grafana Cloud contract.' });
    await asTom('POST', `/api/registry/requests/${made[1].id}/actions`, { action: 'comment', body: 'Attached the quote link in the description — Grafana works too if it covers browser tests.' });
    await act(made[2], { action: 'status', status: 'approved', note: 'Approved by Security and Finance. Ordering this week.' });
    await act(made[2], { action: 'status', status: 'ordered' });
    await act(made[4], { action: 'status', status: 'approved' });
    await act(made[5], { action: 'status', status: 'rejected', note: 'IT Support keeps spare displays — ask the Service Desk to assign two from stock.' });
    // Fulfil the Miro request by creating the asset it asked for.
    await act(made[0], { action: 'status', status: 'approved' });
    await asDana('POST', '/api/registry/assets', {
      assetTypeId: types.software_license.id,
      unitId: platform.id,
      name: 'Miro Business — Platform',
      ownerId: tom,
      requestId: made[0].id,
      attributes: { vendor: 'Miro', seats: 10, cost_per_term: 1200, term_months: 12, notice_days: 30, renewal_date: day(365) },
    });
    env.log(`requests: ${made.length} created across all stages`);
  }
  // ─── Catalogs, sharing, conversations, renewal checks ────────────────────────
  const existingCatalogs = await admin('GET', '/api/registry/catalogs');
  if (!existingCatalogs.length) {
    const asRachel = await login('rachel.amar');
    const asDana = await login('dana.cohen');
    const asTom = await login('tom.levi');
    const rndUnit = byName('R&D');
    const inUnit = async (unit: Json, typeKey: string, n: number): Promise<Json[]> =>
      (await admin('GET', `/api/registry/assets?unitId=${unit.id}&assetTypeId=${types[typeKey].id}&limit=${n}&sort=name&order=asc`)).items;

    // R&D keeps its dev tooling in a catalog and shares it with Sales (view) and Finance (edit, for invoices).
    const tooling = await asRachel('POST', '/api/registry/catalogs', { unitId: rndUnit.id, name: 'R&D developer tooling', description: 'Licenses every engineer can use: IDEs, CI, monitoring.', icon: 'library', color: '#6366f1' });
    for (const a of await inUnit(rndUnit, 'software_license', 8)) await asRachel('PATCH', `/api/registry/assets/${a.id}`, { catalogId: tooling.id });
    await asRachel('POST', `/api/registry/catalogs/${tooling.id}/shares`, { subject: { kind: 'unit', id: byName('Sales').id }, access: { role: 'commenter' } });
    await asRachel('POST', `/api/registry/catalogs/${tooling.id}/shares`, { subject: { kind: 'user', id: idOf('noa.mizrahi') }, access: { role: 'custom', permissions: ['view', 'attach', 'export'] } });

    // A directory-style group (in production these come from LDAP / ADFS) reviews licenses across divisions.
    const groups = await admin('GET', '/api/identity/groups');
    const reviewers = groups.find((g: Json) => g.name === 'Security reviewers') ?? (await admin('POST', '/api/identity/groups', { name: 'Security reviewers', externalId: null }));
    await admin('PUT', `/api/identity/groups/${reviewers.id}/members`, { userIds: users.slice(10, 14).map((u: Json) => u.id) });
    await asRachel('POST', `/api/registry/catalogs/${tooling.id}/shares`, { subject: { kind: 'group', id: reviewers.id }, access: { role: 'custom', permissions: ['view', 'comment', 'restricted'] } });

    // A lab: the division's test devices and SIMs, shared with Customer Care, who reproduce bugs on them.
    const lab = await asRachel('POST', '/api/registry/catalogs', { unitId: rndUnit.id, name: 'Device lab', description: 'Test phones, SIM lines and laptops for reproducing customer issues.', icon: 'flask', color: '#0ea5e9' });
    for (const a of [...(await inUnit(rndUnit, 'hardware', 5)), ...(await inUnit(rndUnit, 'sim_line', 5))]) await asRachel('PATCH', `/api/registry/assets/${a.id}`, { catalogId: lab.id });
    await asRachel('POST', `/api/registry/catalogs/${lab.id}/shares`, { subject: { kind: 'unit', id: byName('Customer Care').id }, access: { role: 'viewer' } });

    // Procurement asks Tom whether to renew one of his licenses; a short conversation around it.
    const toms = (await asTom('GET', '/api/scheduler/obligations?mine=true&limit=200')).items.filter((o: Json) => o.recurring && o.ownerId === tom && !o.check);
    if (toms[0]) {
      await asDana('POST', `/api/scheduler/obligations/${toms[0].id}/actions`, { action: 'ask', message: 'The vendor raised prices 12% this year. Do you still need every seat?' });
      await asTom('POST', `/api/registry/assets/${toms[0].assetId}/comments`, { body: 'Half the team moved to the new whiteboard tool — I think we can cut seats. @Dana Cohen can you get a quote for 20?', mentionIds: [dana] });
      await asDana('POST', `/api/registry/assets/${toms[0].assetId}/comments`, { body: 'Will do. I will hold the renewal until you confirm in the check.', mentionIds: [] });
    }
    env.log('catalogs: 2 created and shared; 1 renewal check waiting for tom.levi');
  }
  // ─── A team variant: R&D extends the license template ────────────────────────
  const variants = await admin('GET', `/api/registry/variants?assetTypeId=${types.software_license.id}`);
  if (!variants.length) {
    const asRachel = await login('rachel.amar');
    const rndUnit = byName('R&D');
    const field = (key: string, label: string, kind: string, config: Json, extra: Json = {}) => ({ id: globalThis.crypto.randomUUID(), key, label, kind, required: false, restricted: false, showInTable: true, section: 'Workstations', config, ...extra });
    const lab = await asRachel('POST', `/api/registry/asset-types/${types.software_license.id}/variants`, {
      unitId: rndUnit.id,
      name: 'Lab license',
      description: 'Node-locked engineering licenses: which machines use them.',
      sections: ['Workstations'],
      fields: [
        field('workstations', 'Workstations', 'assetRef', { assetTypeId: types.hardware.id, multiple: true }),
        field('mac_addresses', 'MAC addresses', 'list', { pattern: '^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$', placeholder: 'AA:BB:CC:DD:EE:FF', maxItems: 50 }),
        field('license_server', 'License server', 'text', {}, { showInTable: false }),
      ],
    });
    const machines = (await admin('GET', `/api/registry/assets?unitId=${rndUnit.id}&assetTypeId=${types.hardware.id}&limit=6`)).items;
    const licenses = (await admin('GET', `/api/registry/assets?unitId=${rndUnit.id}&assetTypeId=${types.software_license.id}&limit=3&sort=name&order=desc`)).items;
    const mac = (n: number) => Array.from({ length: 6 }, (_, i) => ((n * 37 + i * 53) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
    for (const [i, l] of licenses.entries()) {
      await asRachel('PATCH', `/api/registry/assets/${l.id}`, {
        variantId: lab.id,
        attributes: { workstations: machines.slice(i * 2, i * 2 + 2).map((m: Json) => m.id), mac_addresses: [mac(i * 2 + 1), mac(i * 2 + 2)], license_server: `lic-${i + 1}.lab.example.local:27000` },
      });
    }
    env.log(`variants: "Lab license" for R&D, ${licenses.length} licenses use it`);
  }
}
