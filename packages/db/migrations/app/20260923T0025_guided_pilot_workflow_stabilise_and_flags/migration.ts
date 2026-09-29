#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'schemaIssueFlag',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('fieldPath', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('resolvedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('schemaRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'schemaRevision',
        column: col('stabilisedAt', 'timestamptz(6)', {
          codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
        }),
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaIssueFlag',
        index: 'schemaIssueFlag_schemaRevisionId_idx',
        columns: ['schemaRevisionId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaIssueFlag',
        foreignKey: {
          name: 'schemaIssueFlag_schemaRevisionId_fkey',
          columns: ['schemaRevisionId'],
          references: { schema: 'public', table: 'schemaRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
