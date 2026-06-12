import { defineConfig } from 'vitest/config';

/**
 * Dedicated Vitest config so the test runner does NOT load the app's vite.config.ts
 * (whose libp2p plugin spawns the relay server). Tests target the engine modules.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
