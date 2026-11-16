#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from '../20261103T1256_project_chat/end-contract';
import startContract from '../20261103T1256_project_chat/end-contract.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      {
        id: 'retired-contracts.require-current-data', invariantId: 'retired-contracts.require-current-data', label: 'Refuse incompatible historical data before schema changes', operationClass: 'additive' as const,
        target: { id: 'postgres' as const, details: { schema: 'public', objectType: 'table' as const, name: 'extraction' } },
        precheck: [{ description: 'delete incompatible dev rows or use the guarded local pnpm db:reset before retrying', sql: readFileSync(new URL('./require-current-data.sql', import.meta.url), 'utf8') }],
        execute: [{ description: 'leave compatible historical pins unchanged', sql: 'SELECT true' }],
        postcheck: [{ description: 'compatible historical pins remain unchanged', sql: readFileSync(new URL('./require-current-data.sql', import.meta.url), 'utf8') }],
      },
      this.dropTable({ schema: 'public', table: 'annotationSetRevision' }),
      this.dropColumn({ schema: 'public', table: 'batchSchemaSuggestion', column: 'draftVersion' }),
      this.dropConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_batchExtractionId_key',
      }),
      this.dropColumn({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        column: 'batchExtractionId',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'extraction',
        constraint: 'extraction_outcome_check',
      }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'complete' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'diagnostics' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'evidenceLinks' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'failure' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'modelAttribution' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'outcome' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'requestedPages' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'resultPayload' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'reviewDraft' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'reviewDraftVersion' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'reviewPairings' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'reviewTransfer' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'reviewable' }),
      this.dropIndex({ schema: 'public', table: 'extraction', index: 'extraction_reviewedAt_idx' }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'reviewedAt' }),
      this.dropTable({ schema: 'public', table: 'reviewDecision' }),
      this.dropTable({ schema: 'public', table: 'extractionReview' }),
      this.setNotNull({ schema: 'public', table: 'batchExtraction', column: 'requestedSettings' }),
      this.setNotNull({ schema: 'public', table: 'extraction', column: 'requestedSettings' }),
      this.setNotNull({ schema: 'public', table: 'projectSpreadsheetVersion', column: 'rows' }),
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
        table: 'schemaRevision',
        constraint: 'schemaRevision_origin_check',
        column: 'origin',
        values: ['SUGGESTION', 'RESEARCHER_EDIT', 'MODEL_EDIT'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
