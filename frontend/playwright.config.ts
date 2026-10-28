// E2E against the real app and a fake-model backend (eng review D10, OV12): no credits spent.
// Runs its own servers on 5174/8001, so the dev servers on 5173/8000 can keep running.
// Uses the installed Google Chrome (channel: 'chrome'), so no Playwright browser download.
import { defineConfig } from '@playwright/test';

export const E2E_KEY = 'e2e-key';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1320, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'uv run --directory ../backend uvicorn app.asgi:app --port 8001',
      url: 'http://localhost:8001/health',
      reuseExistingServer: false,
      env: {
        SCENEFORK_ADAPTERS: 'fake',
        SCENEFORK_DEMO_TOKEN: E2E_KEY,
        SCENEFORK_ALLOWED_ORIGINS: 'http://localhost:5174',
      },
    },
    {
      command: 'pnpm exec vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: false,
      env: { VITE_BACKEND_URL: 'http://localhost:8001' },
    },
  ],
});
