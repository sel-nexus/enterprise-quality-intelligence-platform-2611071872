/** Start isolated development services for real-browser journeys. */
import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const databasePath = join(mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-playwright-')), 'inventory.sqlite');
const email = process.env.E2E_EMAIL || 'admin@example.test';
const password = process.env.E2E_PASSWORD || 'local-development-password';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90_000,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5177', browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    {
      cwd: '../backend',
      command: 'node node_modules/typescript/bin/tsc -p tsconfig.json && node dist/main.js',
      url: 'http://127.0.0.1:3107/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'development', DEV_LOGIN_ENABLED: 'true', DEV_ADMIN_EMAIL: email,
        DEV_ADMIN_PASSWORD: password, SESSION_SECRET: 'playwright-local-only-secret-32-characters',
        DATABASE_PATH: databasePath, PORT: '3107',
      },
    },
    {
      command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5177 --strictPort',
      url: 'http://127.0.0.1:5177/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_PROXY_TARGET: 'http://127.0.0.1:3107', VITE_API_BASE_URL: '' },
    },
  ],
});
