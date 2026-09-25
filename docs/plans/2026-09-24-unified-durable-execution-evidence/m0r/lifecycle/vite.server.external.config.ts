// Studio's server config plus the explicit line proposed for M2.
import { mergeConfig } from 'vite'
import base from './vite.server.config.ts'

export default mergeConfig(base, {
  ssr: { external: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] },
  build: { outDir: 'dist/server-external' },
})
