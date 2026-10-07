import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Library build for the FREE UI primitives (src/ui). Emits an ES bundle of the
// components plus a Tailwind-compiled stylesheet to dist-lib/, so design-sync's
// package shape can consume them. The app build stays on vite.config.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-lib',
    copyPublicDir: false,
    lib: {
      entry: 'src/ui/index.ts',
      name: 'FreeUI',
      formats: ['es'],
      fileName: 'free-ui',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
  },
})
