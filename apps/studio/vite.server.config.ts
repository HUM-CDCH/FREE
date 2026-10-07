import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'server/index.ts'),
    outDir: 'dist/server',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node24',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
  // DBOS cannot be bundled (its lazy optional requires fail the build), and a bundled copy would be a second DBOS
  // singleton. Studio declares it, so Vite keeps it external; this line pins that choice (M0R 2).
  ssr: { external: ['@dbos-inc/dbos-sdk'] },
})
