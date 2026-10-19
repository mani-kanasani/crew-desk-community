import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4318,
    strictPort: true,
    // Preserve the browser-facing Host so backend Origin checks still match.
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
});
