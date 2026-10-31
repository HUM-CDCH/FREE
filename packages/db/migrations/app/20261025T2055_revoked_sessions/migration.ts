#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from '../20261010T0842_durable_whitespace_recovery/end-contract';
import startContract from '../20261010T0842_durable_whitespace_recovery/end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'revokedSession',
        columns: [
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('expiresAt', 'timestamptz(6)', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
        ],
        constraints: [primaryKey(['digest'])],
      }),
      this.createIndex({
        schema: 'public',
        table: 'revokedSession',
        index: 'revokedSession_expiresAt_idx',
        columns: ['expiresAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
