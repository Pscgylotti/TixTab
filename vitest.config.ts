import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['src/**/*.test.ts'], setupFiles: ['./tests/unit-locale.ts'] },
});
