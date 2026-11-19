#!/usr/bin/env node
// Seeds a realistic, large demo organisation through the public APIs (so every
// rule, event and index applies): a company tree of ~200 units, people with
// team memberships and managers, Procurement and Finance roles, ~400 assets
// across teams, and requests at every stage.
//
// Usage: node scripts/seed-demo.mjs [baseUrl]
// Needs the dev stack and the local admin from .env. Demo accounts use the
// password "password-1234" (local accounts; production uses LDAP/ADFS).
const base = process.argv[2] ?? 'http://localhost:5173';
const ADMIN = { username: process.env.LOCAL_ADMIN_USERNAME ?? 'admin', password: process.env.LOCAL_ADMIN_PASSWORD ?? 'admin-change-me' };
const PASSWORD = 'password-1234';

// Deterministic randomness, so every run produces the same demo.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function client() {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-requested-with': 'asset-management', cookie, ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (username, password = PASSWORD) => {
  const c = client();
  await c('POST', '/api/identity/auth/login', { provider: 'local', username, password });
  return c;
};

const admin = await login(ADMIN.username, ADMIN.password);

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
for (const [division, depts] of Object.entries(org)) {
  lines.push(`Wix / ${division} | CN=${division.toLowerCase().replace(/\W+/g, '-')},OU=Groups,DC=wix,DC=com`);
  for (const [dept, teams] of Object.entries(depts)) {
    lines.push(`Wix / ${division} / ${dept} | department=${dept}`);
    for (const team of teams) lines.push(`Wix / ${division} / ${dept} / ${team} | CN=${team.toLowerCase().replace(/\W+/g, '-')},OU=Teams,DC=wix,DC=com`);
  }
}
// Sales has many small account squads — the long tail of a big org.
for (const region of Object.keys(org.Sales)) for (const country of org.Sales[region]) for (const s of ['Self-serve', 'Enterprise', 'Agencies']) lines.push(`Wix / Sales / ${region} / ${country} / ${country} ${s}`);
for (const dept of Object.keys(org['R&D'])) for (const team of org['R&D'][dept]) for (const s of ['Squad A', 'Squad B']) lines.push(`Wix / R&D / ${dept} / ${team} / ${team} ${s}`);
const imported = await admin('POST', '/api/identity/units/import', { text: lines.join('\n'), kinds: ['Company', 'Division', 'Department', 'Team', 'Squad'] });
console.log(`org chart: ${imported.created} created, ${imported.updated} updated`);
const units = await admin('GET', '/api/identity/units');
const byName = (name) => units.find((u) => u.name === name);
const teams = units.filter((u) => u.kind === 'Team');

// ─── People ──────────────────────────────────────────────────────────────────
const first = ['Dana', 'Tom', 'Rachel', 'Noa', 'Avi', 'Maya', 'Yoni', 'Tamar', 'Eitan', 'Shira', 'Omer', 'Lior', 'Gal', 'Roni', 'Itai', 'Michal', 'Ben', 'Sarah', 'David', 'Emma', 'Lucas', 'Sofia', 'Ivan', 'Ana', 'Kenji', 'Aiko', 'Liam', 'Chloe', 'Mateo', 'Zoe'];
const last = ['Cohen', 'Levi', 'Amar', 'Mizrahi', 'Peretz', 'Biton', 'Friedman', 'Shapiro', 'Katz', 'Klein', 'Novak', 'Silva', 'Tanaka', 'Murphy', 'Schmidt', 'Rossi', 'Dubois', 'Kowalski', 'Jensen', 'Garcia'];
const people = [];
const existingUsers = new Set((await admin('GET', '/api/identity/users?limit=500')).items.map((u) => u.username));
for (let i = 0; i < 60; i++) {
  const displayName = i < first.length ? `${first[i]} ${last[i % last.length]}` : `${pick(first)} ${pick(last)}`;
  const username = displayName.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '') + (i >= first.length ? i : '');
  if (!existingUsers.has(username)) await admin('POST', '/api/identity/users', { username, displayName, email: `${username}@example.local`, password: PASSWORD });
  people.push({ username, displayName });
}
const users = (await admin('GET', '/api/identity/users?limit=500')).items;
const idOf = (username) => users.find((u) => u.username === username).id;

// Personas for the demo.
const dana = idOf('dana.cohen'); // Procurement lead: handles every request
const tom = idOf('tom.levi'); // Platform team member
const rachel = idOf('rachel.amar'); // R&D division head
const noa = idOf('noa.mizrahi'); // Finance: views company-wide spend
const membership = new Map(); // unitId -> { members, managers }
const add = (unit, role, id) => {
  const m = membership.get(unit.id) ?? { members: [], managers: [] };
  m[role].push(id);
  membership.set(unit.id, m);
};
add(byName('Platform'), 'members', tom);
add(byName('R&D'), 'managers', rachel);
add(byName('Software Buying'), 'members', dana);
add(byName('Procurement'), 'managers', dana);
add(byName('FP&A'), 'members', noa);
const rest = users.filter((u) => ![dana, tom, rachel, noa].includes(u.id) && u.username !== ADMIN.username);
rest.forEach((u, i) => add(teams[i % teams.length], i % 9 === 0 ? 'managers' : 'members', u.id));
for (const d of units.filter((u) => u.kind === 'Division' && u.name !== 'R&D')) add(d, 'managers', rest[int(0, rest.length - 1)].id);
for (const [unitId, m] of membership) await admin('PUT', `/api/identity/units/${unitId}/people`, m);
console.log(`people: ${users.length} accounts, ${membership.size} units staffed`);

// Company-wide roles beyond the org chart.
const orgAccess = await admin('GET', '/api/identity/access');
const grant = async (subject, role) => {
  if (!orgAccess.grants.some((g) => g.subject.kind === subject.kind && g.subject.id === subject.id))
    await admin('POST', '/api/identity/grants', { subject, unitId: null, assetTypeId: null, access: { role } });
};
await grant({ kind: 'user', id: dana }, 'admin'); // Procurement: manages templates, handles every request
await grant({ kind: 'user', id: noa }, 'viewer');

// ─── Templates ───────────────────────────────────────────────────────────────
const types = {};
const current = await admin('GET', '/api/registry/asset-types');
for (const key of ['software_license', 'sim_line', 'hardware', 'domain_certificate']) types[key] = current.find((t) => t.key === key) ?? (await admin('POST', `/api/registry/templates/${key}/instantiate`));
await sleep(3000); // projections catch up (units, people)

// ─── Assets ──────────────────────────────────────────────────────────────────
const saas = [
  ['GitHub Enterprise', 'GitHub', 21], ['Datadog Pro', 'Datadog', 23], ['Figma Organization', 'Figma', 45], ['Slack Enterprise Grid', 'Slack', 15], ['Atlassian Cloud', 'Atlassian', 14],
  ['Miro Business', 'Miro', 10], ['Notion Plus', 'Notion', 8], ['Zoom Business', 'Zoom', 13], ['Adobe Creative Cloud', 'Adobe', 85], ['Salesforce Sales Cloud', 'Salesforce', 150],
  ['HubSpot Marketing Hub', 'HubSpot', 90], ['Snowflake Capacity', 'Snowflake', 2000], ['Tableau Creator', 'Tableau', 75], ['PagerDuty Business', 'PagerDuty', 41], ['1Password Business', '1Password', 8],
  ['Okta Workforce', 'Okta', 6], ['Zendesk Suite', 'Zendesk', 115], ['Gong', 'Gong', 120], ['Loom Business', 'Loom', 15], ['Postman Enterprise', 'Postman', 49],
  ['Sentry Business', 'Sentry', 80], ['LaunchDarkly Pro', 'LaunchDarkly', 20], ['Grammarly Business', 'Grammarly', 15], ['DocuSign Business', 'DocuSign', 40], ['Lucid Team', 'Lucid', 9],
];
const have = new Set();
for (let offset = 0; ; offset += 500) {
  const page = await admin('GET', `/api/registry/assets?limit=500&offset=${offset}`);
  page.items.forEach((a) => have.add(a.name));
  if (page.items.length < 500) break;
}
const assets = [];
for (let i = 0; i < 220; i++) {
  const [product, vendor, perSeat] = pick(saas);
  const team = pick(teams);
  const seats = int(3, 120);
  assets.push(['software_license', team, `${product} — ${team.name}`, { vendor, seats, cost_per_term: seats * perSeat * 12, term_months: pick([12, 12, 12, 24, 36]), notice_days: pick([30, 30, 60, 90]), auto_renews: rnd() > 0.4, renewal_date: day(int(-20, 400)), start_date: day(int(-900, -30)), portal_url: `https://${vendor.toLowerCase()}.com` }]);
}
for (const [product, vendor, perSeat] of saas.slice(0, 10)) assets.push(['software_license', byName('Wix'), `${product} — company-wide`, { vendor, seats: int(500, 6000), cost_per_term: int(500, 6000) * perSeat * 12, term_months: 12, notice_days: 90, auto_renews: true, renewal_date: day(int(10, 360)) }]);
const carriers = ['Verizon', 'T-Mobile', 'Vodafone', 'Partner', 'Cellcom', 'O2'];
for (let i = 0; i < 90; i++) {
  const team = pick(units.filter((u) => u.path.length >= 4));
  const assignee = pick(users).id;
  assets.push(['sim_line', team, `Mobile line ${String(1000 + i)}`, { msisdn: `+1 415 555 ${String(1000 + i).slice(-4)}`, iccid: `89012601${String(10_000_000_000 + i * 7919).slice(0, 11)}`, carrier: pick(carriers), plan: pick(['voice_data', 'data_only', 'voice_only', 'iot']), monthly_cost: pick([12, 25, 35, 45, 60]), contract_end: day(int(-30, 500)), assignee }]);
}
const devices = [['MacBook Pro 16"', 3999], ['MacBook Air 13"', 1499], ['Dell XPS 15', 2299], ['ThinkPad X1 Carbon', 1899], ['Studio Display', 1599], ['iPhone 15', 999]];
for (let i = 0; i < 80; i++) {
  const [model, price] = pick(devices);
  const team = pick(teams);
  assets.push(['hardware', team, `${model} #${String(i + 1).padStart(3, '0')}`, { serial: `C02${String(i * 104729).padStart(7, '0')}XR`, model, assignee: pick(users).id, purchase_price: price, purchase_date: day(int(-1000, -10)), warranty_end: day(int(-60, 700)) }]);
}
for (const [fqdn, registrar] of [['wix.com', 'MarkMonitor'], ['*.wixsite.com', 'DigiCert'], ['editorx.com', 'MarkMonitor'], ['*.wixstatic.com', 'DigiCert'], ['wix-bookings.com', 'Gandi'], ['velo.dev', 'Gandi']])
  assets.push(['domain_certificate', byName('Infrastructure'), fqdn, { fqdn, registrar, annual_cost: int(40, 900), expires_on: day(int(5, 300)) }]);

let created = 0;
for (const [type, unit, name, attributes] of assets) {
  if (have.has(name)) continue;
  const owner = membership.get(unit.id)?.members[0] ?? membership.get(unit.id)?.managers[0] ?? null;
  await admin('POST', '/api/registry/assets', { assetTypeId: types[type].id, unitId: unit.id, name, ownerId: owner, attributes });
  created++;
}
console.log(`assets: ${created} created (${assets.length} in the demo set)`);

// ─── Requests ────────────────────────────────────────────────────────────────
const existingRequests = await admin('GET', '/api/registry/requests?scope=all&status=all&limit=1');
if (existingRequests.total === 0) {
  const asTom = await login('tom.levi');
  const asRachel = await login('rachel.amar');
  const asDana = await login('dana.cohen');
  const platform = byName('Platform');
  const ideas = [
    [asTom, platform, 'Miro seats for the Platform team', 'We plan quarterly roadmaps in Miro; 10 of us need edit access.', 10, 1200, types.software_license.id],
    [asTom, byName('Editor'), 'Load-testing tool for the Editor department', 'k6 Cloud or similar; we keep hitting limits of our self-hosted setup.', null, 18000, types.software_license.id],
    [asTom, byName('Wix'), 'Company-wide password manager rollout', 'Security asked every team to move to a shared vault.', 5000, 240000, types.software_license.id],
    [asRachel, byName('R&D'), 'GPU capacity for the AI Assistants team', 'Reserved instances for model fine-tuning, 12 months.', null, 420000, null],
    [asRachel, byName('Data & AI'), 'Snowflake capacity top-up', 'We are at 85% of the annual commit.', null, 150000, types.software_license.id],
    [asTom, platform, 'Two Studio Displays for new hires', 'Starting next month.', 2, 3200, types.hardware.id],
  ];
  const made = [];
  for (const [who, unit, title, description, quantity, amount, assetTypeId] of ideas) {
    made.push(await who('POST', '/api/registry/requests', { title, description, unitId: unit.id, quantity, estimatedCost: { amount, currency: 'USD' }, neededBy: day(int(10, 60)), assetTypeId }));
  }
  const act = (r, body) => asDana('POST', `/api/registry/requests/${r.id}/actions`, body);
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
  console.log(`requests: ${made.length} created across all stages`);
}
// ─── Catalogs, sharing, conversations, renewal checks ────────────────────────
const existingCatalogs = await admin('GET', '/api/registry/catalogs');
if (!existingCatalogs.length) {
  const asRachel = await login('rachel.amar');
  const asDana = await login('dana.cohen');
  const asTom = await login('tom.levi');
  const rnd = byName('R&D');
  const inUnit = async (unit, typeKey, n) =>
    (await admin('GET', `/api/registry/assets?unitId=${unit.id}&assetTypeId=${types[typeKey].id}&limit=${n}&sort=name&order=asc`)).items;

  // R&D keeps its dev tooling in a catalog and shares it with Sales (view) and Finance (edit, for invoices).
  const tooling = await asRachel('POST', '/api/registry/catalogs', { unitId: rnd.id, name: 'R&D developer tooling', description: 'Licenses every engineer can use: IDEs, CI, monitoring.', icon: 'library', color: '#6366f1' });
  for (const a of await inUnit(rnd, 'software_license', 8)) await asRachel('PATCH', `/api/registry/assets/${a.id}`, { catalogId: tooling.id });
  await asRachel('POST', `/api/registry/catalogs/${tooling.id}/shares`, { subject: { kind: 'unit', id: byName('Sales').id }, access: { role: 'commenter' } });
  await asRachel('POST', `/api/registry/catalogs/${tooling.id}/shares`, { subject: { kind: 'user', id: idOf('noa.mizrahi') }, access: { role: 'custom', permissions: ['view', 'attach', 'export'] } });

  // A directory-style group (in production these come from LDAP / ADFS) reviews licenses across divisions.
  const groups = await admin('GET', '/api/identity/groups');
  const reviewers = groups.find((g) => g.name === 'Security reviewers') ?? (await admin('POST', '/api/identity/groups', { name: 'Security reviewers', externalId: null }));
  await admin('PUT', `/api/identity/groups/${reviewers.id}/members`, { userIds: users.slice(10, 14).map((u) => u.id) });
  await asRachel('POST', `/api/registry/catalogs/${tooling.id}/shares`, { subject: { kind: 'group', id: reviewers.id }, access: { role: 'custom', permissions: ['view', 'comment', 'restricted'] } });

  // A lab: the division's test devices and SIMs, shared with Customer Care, who reproduce bugs on them.
  const lab = await asRachel('POST', '/api/registry/catalogs', { unitId: rnd.id, name: 'Device lab', description: 'Test phones, SIM lines and laptops for reproducing customer issues.', icon: 'flask', color: '#0ea5e9' });
  for (const a of [...(await inUnit(rnd, 'hardware', 5)), ...(await inUnit(rnd, 'sim_line', 5))]) await asRachel('PATCH', `/api/registry/assets/${a.id}`, { catalogId: lab.id });
  await asRachel('POST', `/api/registry/catalogs/${lab.id}/shares`, { subject: { kind: 'unit', id: byName('Customer Care').id }, access: { role: 'viewer' } });

  // Procurement asks Tom whether to renew one of his licenses; a short conversation around it.
  const toms = (await asTom('GET', '/api/scheduler/obligations?mine=true&limit=200')).items.filter((o) => o.recurring && o.ownerId === tom && !o.check);
  if (toms[0]) {
    await asDana('POST', `/api/scheduler/obligations/${toms[0].id}/actions`, { action: 'ask', message: 'The vendor raised prices 12% this year. Do you still need every seat?' });
    await asTom('POST', `/api/registry/assets/${toms[0].assetId}/comments`, { body: 'Half the team moved to the new whiteboard tool — I think we can cut seats. @Dana Cohen can you get a quote for 20?', mentionIds: [dana] });
    await asDana('POST', `/api/registry/assets/${toms[0].assetId}/comments`, { body: 'Will do. I will hold the renewal until you confirm in the check.', mentionIds: [] });
  }
  console.log('catalogs: 2 created and shared; 1 renewal check waiting for tom.levi');
}
console.log('\nDemo accounts (password "password-1234"): dana.cohen (Procurement), tom.levi (Platform team), rachel.amar (R&D head), noa.mizrahi (Finance)');
