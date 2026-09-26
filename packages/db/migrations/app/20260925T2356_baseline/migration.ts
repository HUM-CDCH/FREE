#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'annotationSetRevision',
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
          col('revisionNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('snapshot', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
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
      this.createTable({
        schema: 'public',
        table: 'batchExtraction',
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
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('schemaRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('strategy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        columns: [
          col('attempt', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('batchExtractionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('confirmedSchemaRevisionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('coverage', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('draft', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('draftVersion', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('outcome', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('phase', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('proposal', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('selectionKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        columns: [
          col('batchSchemaSuggestionId', '"uuid"', {
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
        constraints: [primaryKey(['batchSchemaSuggestionId', 'sourceDocumentId'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'extraction',
        columns: [
          col('batchExtractionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('catalogRecipe', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('complete', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('diagnostics', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('evidenceLinks', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('modelAttribution', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('outcome', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('requestedModels', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('resultPayload', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('reviewDraft', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('reviewDraftVersion', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('reviewable', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('reviewedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
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
          col('strategy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
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
          col('extractionId', '"uuid"', {
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
        table: 'extractionSchema',
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
        table: 'modelConfiguration',
        columns: [
          col('document', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('researcherAccountId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('updatedAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
        ],
        constraints: [primaryKey(['researcherAccountId'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'projectContext',
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
          col('researcherAccountId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'researcherAccount',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('displayName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('objectId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('tenantId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz@1' },
          }),
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
          col('extractionReviewId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('resultPath', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('resultPathKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reviewedOccurrenceIds', 'jsonb', {
            notNull: true,
            codecRef: { codecId: 'pg/jsonb@1' },
          }),
          col('reviewedValue', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'schemaRevision',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('extractionSchemaId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('modelAttribution', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('origin', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revisionNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('schemaTree', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'sourceDocument',
        columns: [
          col('contentSha256', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('mediaType', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('originalName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        columns: [
          col('artifactReference', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('artifactSha256', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('contractVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('parserName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('parserVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('preprocessId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reprocessFingerprint', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('reprocessKey', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('revisionNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('sourceDocumentId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'annotationSetRevision',
        constraint: 'annotationSetRevision_sourceDocumentId_revisionNumber_key',
        columns: ['sourceDocumentId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchExtraction',
        constraint: 'batch_extraction_pin_key',
        columns: ['id', 'schemaRevisionId', 'strategy'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_selectionKey_key',
        columns: ['selectionKey'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_confirmedSchemaRevisionId_key',
        columns: ['confirmedSchemaRevisionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_batchExtractionId_key',
        columns: ['batchExtractionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        constraint: 'batch_suggestion_source_pin_key',
        columns: ['batchSchemaSuggestionId', 'sourceDocumentId', 'sourceRepresentationRevisionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extraction',
        constraint: 'extraction_id_sourceDocumentId_key',
        columns: ['id', 'sourceDocumentId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extraction',
        constraint: 'extraction_batch_source_key',
        columns: ['batchExtractionId', 'sourceDocumentId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extractionReview',
        constraint: 'extractionReview_extractionId_revisionNumber_key',
        columns: ['extractionId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'researcherAccount',
        constraint: 'researcherAccount_tenantId_objectId_key',
        columns: ['tenantId', 'objectId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'reviewDecision',
        constraint: 'reviewDecision_extractionReviewId_resultPathKey_key',
        columns: ['extractionReviewId', 'resultPathKey'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'schemaRevision',
        constraint: 'schemaRevision_extractionSchemaId_revisionNumber_key',
        columns: ['extractionSchemaId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceDocument',
        constraint: 'sourceDocument_projectContextId_contentSha256_key',
        columns: ['projectContextId', 'contentSha256'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        constraint: 'sourceRepresentationRevision_sourceDocumentId_revisionNumber_key',
        columns: ['sourceDocumentId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        constraint: 'sourceRepresentationRevision_sourceDocumentId_reprocessKey_key',
        columns: ['sourceDocumentId', 'reprocessKey'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        constraint: 'sourceRepresentationRevision_id_sourceDocumentId_key',
        columns: ['id', 'sourceDocumentId'],
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
        table: 'annotationSetRevision',
        index: 'annotationSetRevision_sourceDocumentId_idx',
        columns: ['sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'annotationSetRevision',
        index: 'annotationSetRevision_sourceRepresentationRevisionId_idx',
        columns: ['sourceRepresentationRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchExtraction',
        index: 'batchExtraction_projectContextId_createdAt_idx',
        columns: ['projectContextId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchExtraction',
        index: 'batchExtraction_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchExtraction',
        index: 'batchExtraction_schemaRevisionId_idx',
        columns: ['schemaRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        index: 'batchSchemaSuggestion_projectContextId_createdAt_idx',
        columns: ['projectContextId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        index: 'batchSchemaSuggestion_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        index: 'batchSchemaSuggestionSource_batchSchemaSuggestionId_idx',
        columns: ['batchSchemaSuggestionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        index: 'batch_suggestion_source_representation_idx',
        columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_schemaRevisionId_idx',
        columns: ['schemaRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_sourceDocumentId_createdAt_idx',
        columns: ['sourceDocumentId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_sourceRepresentationRevisionId_sourceDocumentId_idx',
        columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_reviewedAt_idx',
        columns: ['reviewedAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_batch_pin_idx',
        columns: ['batchExtractionId', 'schemaRevisionId', 'strategy'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionReview',
        index: 'extractionReview_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionSchema',
        index: 'extractionSchema_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'projectContext',
        index: 'projectContext_researcherAccountId_idx',
        columns: ['researcherAccountId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reviewDecision',
        index: 'reviewDecision_extractionReviewId_idx',
        columns: ['extractionReviewId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaRevision',
        index: 'schemaRevision_extractionSchemaId_idx',
        columns: ['extractionSchemaId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'sourceDocument',
        index: 'sourceDocument_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        index: 'sourceRepresentationRevision_sourceDocumentId_idx',
        columns: ['sourceDocumentId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'annotationSetRevision',
        foreignKey: {
          name: 'annotationSetRevision_sourceDocumentId_fkey',
          columns: ['sourceDocumentId'],
          references: { schema: 'public', table: 'sourceDocument', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'annotationSetRevision',
        foreignKey: {
          name: 'annotationSetRevision_sourceRepresentationRevisionId_fkey',
          columns: ['sourceRepresentationRevisionId'],
          references: { schema: 'public', table: 'sourceRepresentationRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchExtraction',
        foreignKey: {
          name: 'batchExtraction_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchExtraction',
        foreignKey: {
          name: 'batchExtraction_schemaRevisionId_fkey',
          columns: ['schemaRevisionId'],
          references: { schema: 'public', table: 'schemaRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        foreignKey: {
          name: 'batchSchemaSuggestion_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        foreignKey: {
          name: 'batchSchemaSuggestionSource_batchSchemaSuggestionId_fkey',
          columns: ['batchSchemaSuggestionId'],
          references: { schema: 'public', table: 'batchSchemaSuggestion', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        foreignKey: {
          name: 'batch_suggestion_source_representation_fkey',
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
        table: 'extraction',
        foreignKey: {
          name: 'extraction_schemaRevisionId_fkey',
          columns: ['schemaRevisionId'],
          references: { schema: 'public', table: 'schemaRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extraction',
        foreignKey: {
          name: 'extraction_batch_pin_fkey',
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
        table: 'extraction',
        foreignKey: {
          name: 'extraction_sourceRepresentationRevisionId_sourceDocumentId_fkey',
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
        table: 'extractionSchema',
        foreignKey: {
          name: 'extractionSchema_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'modelConfiguration',
        foreignKey: {
          name: 'modelConfiguration_researcherAccountId_fkey',
          columns: ['researcherAccountId'],
          references: { schema: 'public', table: 'researcherAccount', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'projectContext',
        foreignKey: {
          name: 'projectContext_researcherAccountId_fkey',
          columns: ['researcherAccountId'],
          references: { schema: 'public', table: 'researcherAccount', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'reviewDecision',
        foreignKey: {
          name: 'reviewDecision_extractionReviewId_fkey',
          columns: ['extractionReviewId'],
          references: { schema: 'public', table: 'extractionReview', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaRevision',
        foreignKey: {
          name: 'schemaRevision_extractionSchemaId_fkey',
          columns: ['extractionSchemaId'],
          references: { schema: 'public', table: 'extractionSchema', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'sourceDocument',
        foreignKey: {
          name: 'sourceDocument_projectContextId_fkey',
          columns: ['projectContextId'],
          references: { schema: 'public', table: 'projectContext', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        foreignKey: {
          name: 'sourceRepresentationRevision_sourceDocumentId_fkey',
          columns: ['sourceDocumentId'],
          references: { schema: 'public', table: 'sourceDocument', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
