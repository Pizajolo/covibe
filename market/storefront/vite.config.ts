import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A static site: `npm run build` writes dist/, which any web server can host.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
