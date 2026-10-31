import { defineConfig } from 'vite';

// Trimble Connect loads the extension in an iframe from the URL in the manifest.
// During development, serve over HTTPS if Connect requires it (e.g. with
// @vitejs/plugin-basic-ssl) and add CORS headers so Connect can fetch the manifest.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    cors: true,
    headers: { 'Access-Control-Allow-Origin': '*' },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
