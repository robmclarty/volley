import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    // Each test file's own XDG_STATE_HOME, so runs never write into your home.
    setupFiles: ['test/setup.ts'],
    // Integration tests spawn real subprocesses for check fixtures.
    testTimeout: 30000,
  },
});
