#!/usr/bin/env -S npx tsx
// Seeds the demo organisation into a running server stack through its public API.
//
// Usage: bun run seed [baseUrl]   (default http://localhost:5173)
// Needs the dev stack and the local admin from .env.
import { seedDemo, type Call } from '@am/demo-seed';

const base = process.argv[2] ?? 'http://localhost:5173';

async function login(username: string, password: string): Promise<Call> {
  let cookie = '';
  const call: Call = async (method, path, body) => {
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
  await call('POST', '/api/identity/auth/login', { provider: 'local', username, password });
  return call;
}

await seedDemo({
  admin: { username: process.env.LOCAL_ADMIN_USERNAME ?? 'admin', password: process.env.LOCAL_ADMIN_PASSWORD ?? 'admin-change-me' },
  login,
  // Events travel through pg-boss; give the other services a moment to catch up.
  settle: () => new Promise((r) => setTimeout(r, 3000)),
  log: (m) => console.log(m),
});
console.log('\nDemo accounts (password "password-1234"): dana.cohen (Procurement), tom.levi (Platform team), rachel.amar (R&D head), noa.mizrahi (Finance)');
