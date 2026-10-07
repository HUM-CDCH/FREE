import { Pool } from 'pg';
import postgres from '@prisma-next/postgres/runtime';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

/**
 * Studio's one domain pool. `db` runs on it, and withPoolClientTransaction checks one client out of it per admission.
 * The timeouts are the ones Prisma Next's `url` binding gives its own pool. A pool connects on first use. `db.close()`
 * does not end a pool it was handed, so whoever is done with the database ends this pool.
 */
export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  connectionTimeoutMillis: 20_000,
  idleTimeoutMillis: 30_000,
});

export const db = postgres<Contract>({ contractJson, pg: pool });

export type Database = Pick<typeof db, 'orm' | 'transaction'>;
export type DatabaseOrm = Database['orm'];
/** The context `Database['transaction']` hands its callback: work on it commits or rolls back together. */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
