import { defineConfig } from 'vitest/config';

/**
 * Dedicated Vitest config so the test runner does NOT load the app's vite.config.ts
 * (whose libp2p plugin spawns the relay server). Tests target the engine modules.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Some engine tests do heavy crypto (e.g. archive builds a 300-block chain =
    // hundreds of P-256 signs/verifies) and exceed the 5s default under parallel
    // CPU contention. Generous timeout removes the flake without weakening tests.
    testTimeout: 30_000,
  },
});
