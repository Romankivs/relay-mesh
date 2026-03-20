import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  use: {
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    },
    permissions: ['camera', 'microphone'],
    headless: true,
  },
  reporter: [['list'], ['json', { outputFile: 'tests/e2e/results.json' }]],
});
