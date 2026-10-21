import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/dsp/**/*.test.ts', 'tests/scoring/**/*.test.ts', 'tests/storage/**/*.test.ts'],
    environment: 'node',
  },
});
