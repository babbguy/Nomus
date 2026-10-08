// Chromium via playwright-core (the version pinned in package-lock.json).
// The browser binary comes from `npx playwright-core install chromium`, or
// NOMUS_GATE_CHROMIUM may point at an existing chrome executable.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export async function launchBrowser() {
  const { chromium } = require('playwright-core');
  return chromium.launch({
    headless: true,
    ...(process.env.NOMUS_GATE_CHROMIUM ? { executablePath: process.env.NOMUS_GATE_CHROMIUM } : {}),
  });
}
