#!/usr/bin/env node
// Builds one service (run from its directory):
//   dist/main.mjs       the service — our workspace code (@am/*) bundled,
//                       third-party packages left to node_modules so that
//                       OpenTelemetry can instrument them at runtime
//   dist/telemetry.mjs  the tracing bootstrap, preloaded with `node --import`
// The image ships these next to a production node_modules made by
// `bun install --production --filter <service>` (see the Dockerfile).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/** Bundle @am/* and relative imports; everything else resolves from node_modules. */
const externalThirdParty = {
  name: 'external-third-party',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@am/') ? undefined : { path: args.path, external: true }));
  },
};

const common = { bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: 'linked', logLevel: 'warning', plugins: [externalThirdParty] };

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs' });
await build({
  ...common,
  entryPoints: [fileURLToPath(new URL('../packages/platform/src/telemetry/bootstrap.ts', import.meta.url))],
  outfile: 'dist/telemetry.mjs',
});

console.log(`built ${pkg.name} → dist/main.mjs, dist/telemetry.mjs`);
