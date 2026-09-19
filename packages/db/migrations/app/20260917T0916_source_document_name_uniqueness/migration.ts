#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'projectSpreadsheetVersion',
        columns: [
          col('columns', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('originalFilename', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('revisionNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        column: col('columnFieldMapping', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        column: col('projectSpreadsheetVersionId', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        column: col('sourceKind', 'text', {
          notNull: true,
          default: lit('DOCUMENTS'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'projectSpreadsheetVersion',
        constraint: 'projectSpreadsheetVersion_projectContextId_revisionNumber_key',
        columns: ['projectContextId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceDocument',
        constraint: 'sourceDocument_projectContextId_originalName_key',
        columns: ['projectContextId', 'originalName'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_sourceKind_check',
        column: 'sourceKind',
        values: ['DOCUMENTS', 'SPREADSHEET'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        index: 'batchSchemaSuggestion_projectSpreadsheetVersionId_idx',
        columns: ['projectSpreadsheetVersionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projectSpreadsheetVersion',
        index: 'projectSpreadsheetVersion_projectContextId_createdAt_idx',
        columns: ['projectContextId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projectSpreadsheetVersion',
        index: 'projectSpreadsheetVersion_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'projectSpreadsheetVersion',
        foreignKey: {
          name: 'projectSpreadsheetVersion_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        foreignKey: {
          name: 'batchSchemaSuggestion_projectSpreadsheetVersionId_fkey',
          columns: ['projectSpreadsheetVersionId'],
          references: { schema: 'public', table: 'projectSpreadsheetVersion', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
