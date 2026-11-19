import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** In development each API prefix is proxied to its service; in the cluster nginx does the same. */
const services = { identity: 4001, registry: 4002, files: 4003, scheduler: 4004 };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: Object.fromEntries(Object.entries(services).map(([name, port]) => [`/api/${name}`, { target: `http://localhost:${port}`, changeOrigin: false }])),
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
