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
      // Review Decisions now express per-value approve/edit/reject choices.
      // The old Evidence-only records cannot represent those semantics, so the
      // obsolete review snapshot is removed instead of being guessed forward.
      this.dropTable({ schema: 'public', table: 'reviewDecision' }),
      this.dropTable({ schema: 'public', table: 'extractionReview' }),
      this.createTable({
        schema: 'public',
        table: 'extractionReview',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('decisionDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', { notNull: true, codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('id', '"uuid"', { notNull: true, codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'reviewDecision',
        columns: [
          col('action', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('evidenceAnchorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', { notNull: true, codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('id', '"uuid"', { notNull: true, codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('resultPath', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('resultPathKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reviewedOccurrenceIds', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('reviewedValue', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extractionReview',
        constraint: 'extractionReview_extractionId_key',
        columns: ['extractionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'reviewDecision',
        constraint: 'reviewDecision_extractionId_resultPathKey_key',
        columns: ['extractionId', 'resultPathKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reviewDecision',
        index: 'reviewDecision_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionReview',
        foreignKey: {
          name: 'extractionReview_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'public', table: 'extraction', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reviewDecision',
        foreignKey: {
          name: 'reviewDecision_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'public', table: 'extraction', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
