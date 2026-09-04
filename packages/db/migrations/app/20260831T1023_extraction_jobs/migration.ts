#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma-next/postgres/migration';
import postgresStatic from '@prisma-next/postgres/static';

const { contract, sql } = postgresStatic<End>({ contractJson: endContract });

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dataTransform(contract, 'require-empty-batch-extraction-tables', {
        check: () =>
          sql.public.batchExtraction
            .outerFullJoin(
              sql.public.batchExtractionMember,
              (fields, functions) =>
                functions.eq(
                  fields.batchExtraction.id,
                  fields.batchExtractionMember.batchExtractionId,
                ),
            )
            .select((fields) => ({
              batchExtractionId: fields.batchExtraction.id,
              memberBatchExtractionId:
                fields.batchExtractionMember.batchExtractionId,
            }))
            .limit(1),
        run: () =>
          sql.public.batchExtraction.update((fields) => ({
            createdAt: fields.createdAt,
          })),
      }),
      this.createTable({
        schema: 'public',
        table: 'extractionJob',
        columns: [
          col('batchExtractionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('cancelRequestedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('complete', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('diagnostics', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('executionStatus', 'text', {
            notNull: true,
            default: lit('QUEUED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('finishedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('leaseExpiresAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('leaseOwner', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('leaseVersion', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('modelAttribution', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('rediscover', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
          col('resultPayload', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('retryDocument', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
          col('retryOfId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('retryRecordStartBlockIds', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('schemaRevisionId', '"uuid"', {
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
          col('startedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('strategy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addColumn({
        schema: 'public',
        table: 'batchExtractionMember',
        column: col('initialExtractionJobId', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      this.setNotNull({
        schema: 'public',
        table: 'batchExtractionMember',
        column: 'initialExtractionJobId',
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchExtractionMember',
        constraint: 'batchExtractionMember_initialExtractionJobId_key',
        columns: ['initialExtractionJobId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchExtractionMember',
        constraint: 'batch_member_initial_job_key',
        columns: [
          'initialExtractionJobId',
          'batchExtractionId',
          'sourceDocumentId',
          'sourceRepresentationRevisionId',
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extractionJob',
        constraint: 'extraction_job_batch_member_key',
        columns: ['id', 'batchExtractionId', 'sourceDocumentId', 'sourceRepresentationRevisionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extractionJob',
        constraint: 'extraction_job_retry_pin_key',
        columns: ['id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'extractionJob',
        constraint: 'extractionJob_kind_check',
        column: 'kind',
        values: ['INTERACTIVE', 'BATCH_MEMBER'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'extractionJob',
        constraint: 'extractionJob_executionStatus_check',
        column: 'executionStatus',
        values: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extractionJob_executionStatus_kind_createdAt_idx',
        columns: ['executionStatus', 'kind', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extractionJob_executionStatus_leaseExpiresAt_idx',
        columns: ['executionStatus', 'leaseExpiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extractionJob_sourceDocumentId_createdAt_idx',
        columns: ['sourceDocumentId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extractionJob_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extractionJob_schemaRevisionId_idx',
        columns: ['schemaRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extraction_job_representation_idx',
        columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extraction_job_batch_pin_idx',
        columns: ['batchExtractionId', 'schemaRevisionId', 'strategy'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionJob',
        index: 'extraction_job_retry_pin_idx',
        columns: ['retryOfId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionJob',
        foreignKey: {
          name: 'extractionJob_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionJob',
        foreignKey: {
          name: 'extraction_job_representation_fkey',
          columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
          references: {
            schema: 'public',
            table: 'sourceRepresentationRevision',
            columns: ['id', 'sourceDocumentId'],
          },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionJob',
        foreignKey: {
          name: 'extractionJob_schemaRevisionId_fkey',
          columns: ['schemaRevisionId'],
          references: { schema: 'public', table: 'schemaRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionJob',
        foreignKey: {
          name: 'extraction_job_retry_pin_fkey',
          columns: ['retryOfId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
          references: {
            schema: 'public',
            table: 'extractionJob',
            columns: ['id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
          },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionJob',
        foreignKey: {
          name: 'extraction_job_batch_pin_fkey',
          columns: ['batchExtractionId', 'schemaRevisionId', 'strategy'],
          references: {
            schema: 'public',
            table: 'batchExtraction',
            columns: ['id', 'schemaRevisionId', 'strategy'],
          },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchExtractionMember',
        foreignKey: {
          name: 'batch_member_initial_job_fkey',
          columns: [
            'initialExtractionJobId',
            'batchExtractionId',
            'sourceDocumentId',
            'sourceRepresentationRevisionId',
          ],
          references: {
            schema: 'public',
            table: 'extractionJob',
            columns: [
              'id',
              'batchExtractionId',
              'sourceDocumentId',
              'sourceRepresentationRevisionId',
            ],
          },
          onDelete: 'restrict',
        },
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'batchExtractionMember',
        constraint: 'batchExtractionMember_executionStatus_check',
      }),
      this.dropColumn({
        schema: 'public',
        table: 'batchExtractionMember',
        column: 'executionStatus',
      }),
      this.dropColumn({ schema: 'public', table: 'batchExtractionMember', column: 'failure' }),
      this.dropColumn({ schema: 'public', table: 'batchExtractionMember', column: 'finishedAt' }),
      this.dropColumn({ schema: 'public', table: 'batchExtractionMember', column: 'startedAt' }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'batchExtraction',
        constraint: 'batchExtraction_executionStatus_check',
      }),
      this.dropColumn({ schema: 'public', table: 'batchExtraction', column: 'executionStatus' }),
      this.dropColumn({ schema: 'public', table: 'batchExtraction', column: 'leaseExpiresAt' }),
      this.dropColumn({ schema: 'public', table: 'batchExtraction', column: 'leaseOwner' }),
      this.dropColumn({ schema: 'public', table: 'batchExtraction', column: 'leaseVersion' }),
      this.dropColumn({ schema: 'public', table: 'batchExtraction', column: 'startedAt' }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
