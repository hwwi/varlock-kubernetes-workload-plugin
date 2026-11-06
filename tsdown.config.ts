import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/plugin.ts'],
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: ['varlock', 'varlock/plugin-lib'], onlyBundle: false },
    // Varlock evaluates the entry in its plugin context; another chunk cannot re-enter it.
    outputOptions: { codeSplitting: false },
    sourcemap: true,
    clean: true,
  },
  {
    entry: { 'pull-env': 'src/cli/main.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outputOptions: { entryFileNames: '[name].mjs', codeSplitting: false },
    sourcemap: true,
    clean: true,
  },
]);
