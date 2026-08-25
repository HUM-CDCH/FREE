import { resolve } from 'node:path'
import { loadEnv } from 'vite'

// `pnpm dev` resolves DATABASE_URL from packages/db/.env (see vite.config.ts);
// mirror that here so `pnpm account` works bare as documented in the
// quickstart. A DATABASE_URL already present in the environment wins.
process.env.DATABASE_URL ??= loadEnv(
  'development',
  resolve(import.meta.dirname, '../../../packages/db'),
  '',
).DATABASE_URL
