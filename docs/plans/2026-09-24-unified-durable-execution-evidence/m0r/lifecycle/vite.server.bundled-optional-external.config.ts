// Second negative control: force DBOS into the bundle, but leave its optional
// lazy requires (winston, OpenTelemetry) external so the build itself passes.
import { mergeConfig } from 'vite'
import base from './vite.server.config.ts'

export default mergeConfig(base, {
  ssr: { noExternal: ['@dbos-inc/dbos-sdk', '@dbos-inc/vercel-ai'] },
  build: {
    outDir: 'dist/server-bundled-optional-external',
    rollupOptions: { external: [/^winston/, /^@opentelemetry\//] },
  },
})
