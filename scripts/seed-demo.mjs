#!/usr/bin/env node
// Seeds demo data through the public APIs (so every rule and event applies).
// Usage: node scripts/seed-demo.mjs [baseUrl] — expects the dev stack and the
// local admin from .env (LOCAL_ADMIN_USERNAME / LOCAL_ADMIN_PASSWORD).
const base = process.argv[2] ?? 'http://localhost:5173';
const username = process.env.LOCAL_ADMIN_USERNAME ?? 'admin';
const password = process.env.LOCAL_ADMIN_PASSWORD ?? 'admin-change-me';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-requested-with': 'asset-management', cookie, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

await call('POST', '/api/identity/auth/login', { provider: 'local', username, password });

const existing = await call('GET', '/api/identity/purchase-classes');
const classes = {};
for (const pc of [
  { key: 'engineering', name: 'Engineering', color: '#6366f1', description: 'Product & platform teams' },
  { key: 'marketing', name: 'Marketing', color: '#ec4899', description: 'Brand, growth and events' },
  { key: 'client_acme', name: 'Client: Acme Corp', color: '#f59e0b', description: 'Re-billed to Acme' },
  { key: 'operations', name: 'Operations', color: '#10b981', description: 'Finance, HR, facilities' },
]) {
  const found = existing.find((e) => e.key === pc.key);
  classes[pc.key] = found ?? (await call('POST', '/api/identity/purchase-classes', pc));
  if (found) await call('PUT', `/api/identity/purchase-classes/${found.id}`, { ...pc, archived: false }); // re-publish for projections
}
console.log('purchase classes ready');

const types = {};
const current = await call('GET', '/api/registry/asset-types');
for (const key of ['software_license', 'sim_line', 'hardware', 'domain_certificate']) {
  types[key] = current.find((t) => t.key === key) ?? (await call('POST', `/api/registry/templates/${key}/instantiate`));
}
console.log('templates ready');
await sleep(3000); // let projections catch up

const me = await call('GET', '/api/identity/me');
const assets = [
  ['software_license', 'engineering', 'GitHub Enterprise', { vendor: 'GitHub', seats: 120, cost_per_term: 25200, term_months: 12, notice_days: 60, auto_renews: true, renewal_date: day(41), start_date: day(-324), license_key: 'GHE-7Q2K-99XL', portal_url: 'https://github.com/enterprises' }],
  ['software_license', 'engineering', 'Datadog Pro', { vendor: 'Datadog', seats: 40, cost_per_term: 54000, term_months: 12, notice_days: 30, auto_renews: true, renewal_date: day(12), portal_url: 'https://app.datadoghq.com' }],
  ['software_license', 'marketing', 'Figma Organization', { vendor: 'Figma', seats: 18, cost_per_term: 9720, term_months: 12, notice_days: 30, renewal_date: day(5) }],
  ['software_license', 'marketing', 'HubSpot Marketing Hub', { vendor: 'HubSpot', seats: 6, cost_per_term: 21600, term_months: 12, notice_days: 90, auto_renews: true, renewal_date: day(130) }],
  ['software_license', 'operations', 'Slack Business+', { vendor: 'Slack', seats: 210, cost_per_term: 31500, term_months: 12, notice_days: 30, renewal_date: day(-3) }],
  ['software_license', 'client_acme', 'Adobe CC — Acme project', { vendor: 'Adobe', seats: 4, cost_per_term: 3400, term_months: 12, notice_days: 14, renewal_date: day(23) }],
  ['sim_line', 'operations', 'Field team line 01', { msisdn: '+1 415 555 0101', iccid: '8901260123456789012', carrier: 'Verizon', plan: 'voice_data', monthly_cost: 45, contract_end: day(9), assignee: me.userId }],
  ['sim_line', 'operations', 'Field team line 02', { msisdn: '+1 415 555 0102', carrier: 'Verizon', plan: 'voice_data', monthly_cost: 45, contract_end: day(190) }],
  ['sim_line', 'client_acme', 'Acme IoT gateway', { msisdn: '+1 650 555 0177', carrier: 'T-Mobile', plan: 'iot', monthly_cost: 12, contract_end: day(64) }],
  ['hardware', 'engineering', 'MacBook Pro 16" — build agent', { serial: 'C02FQ1ABMD6R', model: 'MacBook Pro M3 Max', purchase_price: 3999, purchase_date: day(-700), warranty_end: day(30), assignee: me.userId }],
  ['hardware', 'operations', 'Dell PowerEdge R760 — rack 2', { serial: 'J7X2QK3', model: 'PowerEdge R760', purchase_price: 11250, purchase_date: day(-400), warranty_end: day(330) }],
  ['domain_certificate', 'engineering', 'example.com wildcard TLS', { fqdn: '*.example.com', registrar: 'DigiCert', annual_cost: 595, expires_on: day(18) }],
  ['domain_certificate', 'marketing', 'example.io', { fqdn: 'example.io', registrar: 'Gandi', annual_cost: 48, expires_on: day(220) }],
];
const have = new Set((await call('GET', '/api/registry/assets', undefined)).items?.map((a) => a.name) ?? []);
for (const [type, pc, name, attributes] of assets) {
  if (have.has(name)) continue;
  await call('POST', '/api/registry/assets', { assetTypeId: types[type].id, purchaseClassId: classes[pc].id, name, attributes });
}
console.log(`seeded ${assets.length} assets`);
