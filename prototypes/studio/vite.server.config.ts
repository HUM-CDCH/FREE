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
})
