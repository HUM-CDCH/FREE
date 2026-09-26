// Negative control: Studio's server config, but force DBOS INTO the bundle.
import { mergeConfig } from 'vite'
import base from './vite.server.config.ts'

export default mergeConfig(base, {
  ssr: { noExternal: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] },
  build: { outDir: 'dist/server-bundled' },
})
