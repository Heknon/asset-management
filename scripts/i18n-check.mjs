#!/usr/bin/env node
// Merges apps/web/src/i18n/he-parts/*.json into he.json (when the parts folder exists)
// and checks that every literal key passed to t()/plural()/tj() in the web app has a
// Hebrew translation with the same {placeholders}. Exit code 1 lists what is missing.
//   bun scripts/i18n-check.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../apps/web/src', import.meta.url));
const dictPath = join(src, 'i18n/he.json');
const partsDir = join(src, 'i18n/he-parts');

let dict = JSON.parse(readFileSync(dictPath, 'utf8'));
if (existsSync(partsDir)) {
  for (const f of readdirSync(partsDir).filter((f) => f.endsWith('.json')).sort()) {
    const part = JSON.parse(readFileSync(join(partsDir, f), 'utf8'));
    for (const [k, v] of Object.entries(part)) {
      if (dict[k] && dict[k] !== v) console.warn(`different translations for "${k}": "${dict[k]}" vs "${v}" (${f}); keeping the first`);
      dict[k] ??= v;
    }
  }
  dict = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(dictPath, JSON.stringify(dict, null, 2) + '\n');
}

/** String literals passed as the first argument (and plural's two forms). */
const literal = String.raw`(['"\`])((?:\\.|(?!\1)[^\\])*)\1`;
const calls = [
  new RegExp(String.raw`\b(?:t|tj)\(\s*${literal}`, 'g'),
  new RegExp(String.raw`\bplural\(\s*[^,]+,\s*${literal}\s*,\s*${literal}`, 'g'),
];
const unescape = (s, q) => (q === '`' && s.includes('${') ? null : s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'));

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) yield p;
  }
}

const used = new Map();
for (const f of files(src)) {
  const text = readFileSync(f, 'utf8');
  for (const re of calls) {
    for (const m of text.matchAll(re)) {
      const pairs = m.length > 4 ? [[m[1], m[2]], [m[3], m[4]]] : [[m[1], m[2]]];
      for (const [q, s] of pairs) {
        const key = unescape(s, q);
        if (key) used.set(key, f.slice(src.length + 1));
      }
    }
  }
}

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const missing = [...used].filter(([k]) => !(k in dict));
const badHoles = [...used].filter(([k]) => k in dict && holes(k) !== holes(dict[k]));
const unused = Object.keys(dict).filter((k) => !used.has(k));

console.log(`${used.size} keys in code, ${Object.keys(dict).length} translated, ${missing.length} missing, ${badHoles.length} with mismatched placeholders, ${unused.length} not referenced literally (labels via tMaybe, dynamic keys)`);
for (const [k, f] of missing.slice(0, 200)) console.log(`  missing  ${JSON.stringify(k)}  (${f})`);
for (const [k, f] of badHoles) console.log(`  {holes}  ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}  (${f})`);
process.exit(missing.length || badHoles.length ? 1 : 0);
