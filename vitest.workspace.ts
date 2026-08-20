import { fileURLToPath } from 'node:url';
import { defineWorkspace } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * `server-only` は Client Component からの import を検出するための番人だが、
 * Vitest には Server/Client の区別がないため、テスト時のみ無害なスタブへ差し替える。
 * （Client Bundle への混入検出は `next build` が担う）
 */
const serverOnlyStub = fileURLToPath(new URL('./tests/setup/server-only-stub.ts', import.meta.url));

export default defineWorkspace([
  {
    plugins: [tsconfigPaths(), react()],
    resolve: { alias: { 'server-only': serverOnlyStub } },
    test: {
      name: 'unit',
      environment: 'happy-dom',
      globals: true,
      include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
      setupFiles: ['tests/setup/unit-setup.ts'],
    },
  },
  {
    plugins: [tsconfigPaths()],
    resolve: { alias: { 'server-only': serverOnlyStub } },
    test: {
      name: 'integration',
      environment: 'node',
      globals: true,
      include: ['tests/integration/**/*.test.ts'],
      setupFiles: ['tests/setup/unit-setup.ts'],
      testTimeout: 30_000,
    },
  },
  {
    plugins: [tsconfigPaths()],
    resolve: { alias: { 'server-only': serverOnlyStub } },
    test: {
      name: 'rls',
      environment: 'node',
      globals: true,
      include: ['tests/rls/**/*.test.ts'],
      testTimeout: 180_000,
      hookTimeout: 180_000,
      // PGlite インスタンスはプロセス単位で共有する（起動コストが高いため）
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
