import postgres from '@prisma-next/postgres/runtime';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

export const db = postgres<Contract>({
  contractJson,
  url: process.env['DATABASE_URL']!,
});

export type Database = Pick<typeof db, 'orm' | 'transaction'>;
export type DatabaseOrm = Database['orm'];
/** The context `Database['transaction']` hands its callback: work on it commits or rolls back together. */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
