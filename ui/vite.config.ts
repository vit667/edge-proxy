import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // `npm run dev` talks to a running agent's admin API.
  server: { port: 5178, proxy: { '/admin': 'http://127.0.0.1:8788' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 }
});
