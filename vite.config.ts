import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// BASE_PATH 由部署流程注入：GitHub Pages 项目站点为 /<repo>/
const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  base: env.BASE_PATH ?? '/',
  plugins: [preact(), viteSingleFile()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: () => true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
