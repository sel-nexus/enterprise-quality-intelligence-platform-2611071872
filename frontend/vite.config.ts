/** Configure the frontend build, development proxy, and component tests. */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: { port: 5173, proxy: { '/api': env.VITE_PROXY_TARGET || 'http://localhost:3000' } },
    test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
  };
});
