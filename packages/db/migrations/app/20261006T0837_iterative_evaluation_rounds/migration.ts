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
        table: 'evaluationRound',
        columns: [
          col('completedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('documents', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('label', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metrics', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('pins', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('pipelineRunId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('projectSpreadsheetVersionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/text@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'evaluationRound',
        constraint: 'evaluationRound_projectContextId_pipelineRunId_label_key',
        columns: ['projectContextId', 'pipelineRunId', 'label'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_outcome_check',
        column: 'outcome',
        values: ['SUCCEEDED', 'FAILED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_phase_check',
        column: 'phase',
        values: ['READY', 'HETEROGENEOUS'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_sourceKind_check',
        column: 'sourceKind',
        values: ['DOCUMENTS', 'SPREADSHEET'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'evaluationRound',
        constraint: 'evaluationRound_label_check',
        column: 'label',
        values: ['PILOT_1', 'PILOT_2', 'BATCH'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'evaluationRound',
        constraint: 'evaluationRound_status_check',
        column: 'status',
        values: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'extraction',
        constraint: 'extraction_outcome_check',
        column: 'outcome',
        values: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'schemaRevision',
        constraint: 'schemaRevision_origin_check',
        column: 'origin',
        values: ['SUGGESTION', 'RESEARCHER_EDIT', 'MODEL_EDIT'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRound',
        index: 'evaluationRound_projectContextId_createdAt_idx',
        columns: ['projectContextId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRound',
        index: 'evaluationRound_projectSpreadsheetVersionId_idx',
        columns: ['projectSpreadsheetVersionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'evaluationRound',
        index: 'evaluationRound_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationRound',
        foreignKey: {
          name: 'evaluationRound_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'evaluationRound',
        foreignKey: {
          name: 'evaluationRound_projectSpreadsheetVersionId_fkey',
          columns: ['projectSpreadsheetVersionId'],
          references: { schema: 'public', table: 'projectSpreadsheetVersion', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
