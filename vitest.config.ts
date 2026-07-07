import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    // Integration tests spawn real subprocesses for check fixtures.
    testTimeout: 30000,
  },
});
