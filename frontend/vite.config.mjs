import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0', allowedHosts: true,
    proxy: { '/api/legal': 'http://127.0.0.1:8787' },
  },
});
