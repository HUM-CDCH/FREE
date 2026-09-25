// Studio's vite.server.config.ts, with the proposed M2 line switched on by env.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  ...(process.env.M0R_EXPLICIT_EXTERNAL
    ? { ssr: { external: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] } }
    : {}),
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
})
