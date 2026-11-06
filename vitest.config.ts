import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          include: ['test/environment.test.ts', 'test/plugin.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'package',
          include: ['test/package.test.ts'],
          testTimeout: 180_000,
        },
      },
      {
        test: {
          name: 'cluster',
          include: ['test/cluster.test.ts'],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
