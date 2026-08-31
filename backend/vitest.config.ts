import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // FSD 11.6: "Automated test coverage required on the scoring and result
      // engine specifically; this is the component where a defect is most
      // expensive." These thresholds are enforced in CI.
      include: ['src/services/**', 'src/modules/**'],
      thresholds: {
        'src/services/scoring/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
