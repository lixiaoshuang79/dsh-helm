import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const pkgs = ['protocol', 'store', 'hub', 'node-agent', 'presence', 'platform', 'cli']

export default defineConfig({
  resolve: {
    alias: pkgs.map((p) => ({
      find: new RegExp(`^@dsh-helm/${p}$`),
      replacement: resolve(root, `packages/${p}/src/index.ts`),
    })),
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
})
