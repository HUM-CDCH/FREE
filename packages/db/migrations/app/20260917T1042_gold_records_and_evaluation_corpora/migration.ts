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
        table: 'evaluationCorpus',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'evaluationCorpusVersion',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('evaluationCorpusId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('revisionNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'evaluationRun',
        columns: [
          col('batchExtractionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('computedAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('evaluationCorpusVersionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('extractionId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('metrics', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('schemaRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'goldRecord',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('evaluationCorpusVersionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('fields', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('sourceDocumentId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('sourceRepresentationRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        column: col('purpose', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'evaluationCorpusVersion',
        constraint: 'evaluationCorpusVersion_evaluationCorpusId_revisionNumber_key',
        columns: ['evaluationCorpusId', 'revisionNumber'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_purpose_check',
        column: 'purpose',
        values: ['SCHEMA', 'SCHEMA_AND_VALIDATE'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationCorpus',
        index: 'evaluationCorpus_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationCorpusVersion',
        index: 'evaluationCorpusVersion_evaluationCorpusId_idx',
        columns: ['evaluationCorpusId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRun',
        index: 'evaluationRun_evaluationCorpusVersionId_computedAt_idx',
        columns: ['evaluationCorpusVersionId', 'computedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRun',
        index: 'evaluationRun_schemaRevisionId_idx',
        columns: ['schemaRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRun',
        index: 'evaluationRun_batchExtractionId_idx',
        columns: ['batchExtractionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRun',
        index: 'evaluationRun_evaluationCorpusVersionId_idx',
        columns: ['evaluationCorpusVersionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRun',
        index: 'evaluationRun_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'goldRecord',
        index: 'goldRecord_evaluationCorpusVersionId_idx',
        columns: ['evaluationCorpusVersionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'goldRecord',
        index: 'goldRecord_sourceDocumentId_idx',
        columns: ['sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'goldRecord',
        index: 'goldRecord_sourceRepresentationRevisionId_idx',
        columns: ['sourceRepresentationRevisionId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationCorpus',
        foreignKey: {
          name: 'evaluationCorpus_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationCorpusVersion',
        foreignKey: {
          name: 'evaluationCorpusVersion_evaluationCorpusId_fkey',
          columns: ['evaluationCorpusId'],
          references: { schema: 'public', table: 'evaluationCorpus', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationRun',
        foreignKey: {
          name: 'evaluationRun_evaluationCorpusVersionId_fkey',
          columns: ['evaluationCorpusVersionId'],
          references: { schema: 'public', table: 'evaluationCorpusVersion', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationRun',
        foreignKey: {
          name: 'evaluationRun_schemaRevisionId_fkey',
          columns: ['schemaRevisionId'],
          references: { schema: 'public', table: 'schemaRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationRun',
        foreignKey: {
          name: 'evaluationRun_batchExtractionId_fkey',
          columns: ['batchExtractionId'],
          references: { schema: 'public', table: 'batchExtraction', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationRun',
        foreignKey: {
          name: 'evaluationRun_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'public', table: 'extraction', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'goldRecord',
        foreignKey: {
          name: 'goldRecord_evaluationCorpusVersionId_fkey',
          columns: ['evaluationCorpusVersionId'],
          references: { schema: 'public', table: 'evaluationCorpusVersion', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'goldRecord',
        foreignKey: {
          name: 'goldRecord_sourceDocumentId_fkey',
          columns: ['sourceDocumentId'],
          references: { schema: 'public', table: 'sourceDocument', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'goldRecord',
        foreignKey: {
          name: 'goldRecord_sourceRepresentationRevisionId_fkey',
          columns: ['sourceRepresentationRevisionId'],
          references: { schema: 'public', table: 'sourceRepresentationRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
