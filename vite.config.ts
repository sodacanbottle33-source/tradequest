/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The shared market runs on the TradeQuest server (`npm run server`, port 8787 unless TQ_PORT says otherwise).
// While developing, the page on :5173 passes every /api request (including the live event stream) to that server.
const serverPort = process.env.TQ_PORT && process.env.TQ_PORT !== '' ? process.env.TQ_PORT : '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
