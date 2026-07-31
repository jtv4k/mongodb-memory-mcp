import { defineConfig } from 'vitest/config';

/**
 * Two test projects, deliberately separated:
 *
 *  - `unit`        — pure logic (chunking, embedding provider with mocked fetch,
 *                    config validation, rank fusion). NEVER touches a database or
 *                    the network. `npm test` runs only this.
 *  - `integration` — real Atlas Local, real vector index, real $vectorSearch.
 *                    Each file gets its own randomised database name (see
 *                    tests/integration/setup.ts) so parallel runs cannot collide.
 *
 * Run:  npm test   |   npm run test:integration   |   npm run test:all
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          root: import.meta.dirname,
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: 'integration',
          root: import.meta.dirname,
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts'],
          // Creating an Atlas Search index and waiting for it to become
          // queryable is slow — minutes, not seconds, on a cold container.
          testTimeout: 180_000,
          hookTimeout: 300_000,
          // Search-index creation is heavy and Atlas Local is a single node, so
          // run every integration file sequentially in one process. (`fileParallelism`
          // is root-only in Vitest 3; `singleFork` is the per-project equivalent.)
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/views/**', 'src/index.ts'],
    },
  },
});
