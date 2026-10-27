import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev:ui` serves the UI with hot reload and proxies the API to a
// server started with `covibe app --port 4317 --no-open`.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: '../dist-ui', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', headers: { host: '127.0.0.1' } } } },
});
