import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/ui',
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: 'chromium',
    launchOptions: {
      executablePath:
        process.env.TASKWEAVE_CHROMIUM_PATH ??
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
      args: ['--no-sandbox'],
    },
    viewport: { width: 1280, height: 900 },
  },
  reporter: 'list',
  outputDir: 'test-results',
});
