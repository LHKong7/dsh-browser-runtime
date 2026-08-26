import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^dsh-browser-runtime\/playwright$/, replacement: fileURLToPath(new URL('./src/playwright.ts', import.meta.url)) },
      { find: /^dsh-browser-runtime\/tools$/, replacement: fileURLToPath(new URL('./src/tools.ts', import.meta.url)) },
      { find: /^dsh-browser-runtime$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
  },
})
