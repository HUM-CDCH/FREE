#!/usr/bin/env -S node
import { readFileSync } from 'node:fs';
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'extraction_runtime',
        table: 'callFailure',
        columns: [
          col('attemptId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('captureId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('inputDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('output', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('outputDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['captureId', 'attemptId'])],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'callFailure',
        index: 'callFailure_captureId_idx',
        columns: ['captureId'],
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'callFailure',
        foreignKey: {
          name: 'callFailure_captureId_fkey',
          columns: ['captureId'],
          references: { schema: 'extraction_runtime', table: 'capture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      {
        id: 'extraction-runtime.retry-history', label: 'Retain failed responses separately from completed calls', operationClass: 'additive' as const,
        target: { id: 'postgres' as const, details: { schema: 'extraction_runtime', objectType: 'table' as const, name: 'callFailure' } },
        precheck: [{ description: 'failure history exists', sql: "SELECT to_regclass('extraction_runtime.\"callFailure\"') IS NOT NULL AS ok" }],
        execute: [{ description: 'install retry-aware checkpoint routines', sql: readFileSync(new URL('./runtime.sql', import.meta.url), 'utf8') }],
        postcheck: [{ description: 'failure history is immutable', sql: "SELECT EXISTS (SELECT FROM pg_trigger WHERE tgname='callFailure_immutable') AS ok" }],
      },
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
