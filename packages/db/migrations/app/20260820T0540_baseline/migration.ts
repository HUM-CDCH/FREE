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
          col('leaseExpiresAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('leaseOwner', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('leaseVersion', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('schemaRevisionId', '"uuid"', {
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
      this.createTable({
        schema: 'public',
        table: 'batchExtractionMember',
        columns: [
          col('batchExtractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('executionStatus', 'text', {
            notNull: true,
            default: lit('QUEUED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('finishedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
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
        ],
        constraints: [primaryKey(['batchExtractionId', 'sourceDocumentId'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        columns: [
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
          col('leaseExpiresAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('leaseOwner', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('leaseVersion', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('phase', 'text', {
            notNull: true,
            default: lit('SOURCES'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('projectContextId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('proposal', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('selectionKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('startedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
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
          col('definition', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('executionStatus', 'text', {
            notNull: true,
            default: lit('QUEUED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('finishedAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
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
        ],
        constraints: [primaryKey(['batchSchemaSuggestionId', 'sourceDocumentId'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        columns: [
          col('annotationSetRevisionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('baseSchemaRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('extractionSchemaId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('instruction', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('modelAttribution', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('operations', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptRevisionId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('proposedTree', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('rawModelOutput', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('sourceRepresentationRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'extraction',
        columns: [
          col('batchExtractionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('complete', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('diagnostics', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('evidenceLinks', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('modelAttribution', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('resultPayload', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('retryOfId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('reviewable', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
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
        table: 'promptRevision',
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
          col('revisionNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('text', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
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
          col('disabledAt', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('mustChangePassword', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('passwordHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('sessionVersion', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
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
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('evidenceAnchorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('reviewedOccurrenceIds', 'jsonb', {
            notNull: true,
            codecRef: { codecId: 'pg/jsonb@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'schemaRevision',
        columns: [
          col('conversationalSchemaEditId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
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
          col('schemaSuggestionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('schemaTree', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'schemaSuggestion',
        columns: [
          col('annotationMode', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('extractionSchemaId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('modelAttribution', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('outcome', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('promptRevisionId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('proposedTree', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('rawModelOutput', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'schemaSuggestionInput',
        columns: [
          col('annotationSetRevisionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('schemaSuggestionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('sourceRepresentationRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['schemaSuggestionId', 'sourceRepresentationRevisionId'])],
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
          col('ingestionKey', '"uuid"', {
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
        table: 'batchExtractionMember',
        constraint: 'batch_member_exact_pin_key',
        columns: ['batchExtractionId', 'sourceDocumentId', 'sourceRepresentationRevisionId'],
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
        constraint: 'extraction_retry_pin_key',
        columns: ['id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'extractionReview',
        constraint: 'extractionReview_extractionId_key',
        columns: ['extractionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'promptRevision',
        constraint: 'promptRevision_extractionSchemaId_revisionNumber_key',
        columns: ['extractionSchemaId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'researcherAccount',
        constraint: 'researcherAccount_email_key',
        columns: ['email'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'reviewDecision',
        constraint: 'reviewDecision_extractionId_evidenceAnchorId_key',
        columns: ['extractionId', 'evidenceAnchorId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'schemaRevision',
        constraint: 'schemaRevision_schemaSuggestionId_key',
        columns: ['schemaSuggestionId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'schemaRevision',
        constraint: 'schemaRevision_conversationalSchemaEditId_key',
        columns: ['conversationalSchemaEditId'],
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
        constraint: 'sourceDocument_projectContextId_ingestionKey_key',
        columns: ['projectContextId', 'ingestionKey'],
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
        constraint: 'sourceRepresentationRevision_id_sourceDocumentId_key',
        columns: ['id', 'sourceDocumentId'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchExtraction',
        constraint: 'batchExtraction_executionStatus_check',
        column: 'executionStatus',
        values: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchExtractionMember',
        constraint: 'batchExtractionMember_executionStatus_check',
        column: 'executionStatus',
        values: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_executionStatus_check',
        column: 'executionStatus',
        values: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestion',
        constraint: 'batchSchemaSuggestion_phase_check',
        column: 'phase',
        values: ['SOURCES', 'MERGING', 'READY', 'HETEROGENEOUS'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        constraint: 'batchSchemaSuggestionSource_executionStatus_check',
        column: 'executionStatus',
        values: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        constraint: 'conversationalSchemaEdit_outcome_check',
        column: 'outcome',
        values: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
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
      this.addCheckConstraint({
        schema: 'public',
        table: 'schemaSuggestion',
        constraint: 'schemaSuggestion_annotationMode_check',
        column: 'annotationMode',
        values: ['hints', 'fields'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'schemaSuggestion',
        constraint: 'schemaSuggestion_outcome_check',
        column: 'outcome',
        values: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
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
        table: 'batchExtractionMember',
        index: 'batchExtractionMember_batchExtractionId_idx',
        columns: ['batchExtractionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchExtractionMember',
        index: 'batch_member_representation_idx',
        columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
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
        index: 'batchSchemaSuggestion_executionStatus_leaseExpiresAt_idx',
        columns: ['executionStatus', 'leaseExpiresAt'],
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
        index: 'batchSchemaSuggestionSource_sourceRepresentationRevisionId_idx',
        columns: ['sourceRepresentationRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'batchSchemaSuggestionSource',
        index: 'batch_suggestion_source_representation_idx',
        columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        index: 'conversationalSchemaEdit_extractionSchemaId_idx',
        columns: ['extractionSchemaId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        index: 'conversationalSchemaEdit_annotationSetRevisionId_idx',
        columns: ['annotationSetRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        index: 'conversationalSchemaEdit_baseSchemaRevisionId_idx',
        columns: ['baseSchemaRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        index: 'conversationalSchemaEdit_promptRevisionId_idx',
        columns: ['promptRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        index: 'conversationalSchemaEdit_sourceRepresentationRevisionId_idx',
        columns: ['sourceRepresentationRevisionId'],
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
        index: 'extraction_batchExtractionId_sourceDocumentId_sourceRepresentationRevisionId_idx',
        columns: ['batchExtractionId', 'sourceDocumentId', 'sourceRepresentationRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_batch_pin_idx',
        columns: ['batchExtractionId', 'schemaRevisionId', 'strategy'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_retry_pin_idx',
        columns: ['retryOfId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
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
        table: 'promptRevision',
        index: 'promptRevision_extractionSchemaId_idx',
        columns: ['extractionSchemaId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reviewDecision',
        index: 'reviewDecision_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaRevision',
        index: 'schemaRevision_extractionSchemaId_idx',
        columns: ['extractionSchemaId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestion',
        index: 'schemaSuggestion_extractionSchemaId_idx',
        columns: ['extractionSchemaId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestion',
        index: 'schemaSuggestion_promptRevisionId_idx',
        columns: ['promptRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestionInput',
        index: 'schemaSuggestionInput_annotationSetRevisionId_idx',
        columns: ['annotationSetRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestionInput',
        index: 'schemaSuggestionInput_schemaSuggestionId_idx',
        columns: ['schemaSuggestionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestionInput',
        index: 'schemaSuggestionInput_sourceRepresentationRevisionId_idx',
        columns: ['sourceRepresentationRevisionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'sourceDocument',
        index: 'sourceDocument_contentSha256_idx',
        columns: ['contentSha256'],
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
        table: 'batchExtractionMember',
        foreignKey: {
          name: 'batchExtractionMember_batchExtractionId_fkey',
          columns: ['batchExtractionId'],
          references: { schema: 'public', table: 'batchExtraction', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'batchExtractionMember',
        foreignKey: {
          name: 'batch_member_representation_fkey',
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
          name: 'batchSchemaSuggestionSource_sourceRepresentationRevisionId_fkey',
          columns: ['sourceRepresentationRevisionId'],
          references: { schema: 'public', table: 'sourceRepresentationRevision', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        foreignKey: {
          name: 'conversationalSchemaEdit_extractionSchemaId_fkey',
          columns: ['extractionSchemaId'],
          references: { schema: 'public', table: 'extractionSchema', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        foreignKey: {
          name: 'conversationalSchemaEdit_baseSchemaRevisionId_fkey',
          columns: ['baseSchemaRevisionId'],
          references: { schema: 'public', table: 'schemaRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        foreignKey: {
          name: 'conversationalSchemaEdit_sourceRepresentationRevisionId_fkey',
          columns: ['sourceRepresentationRevisionId'],
          references: { schema: 'public', table: 'sourceRepresentationRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        foreignKey: {
          name: 'conversationalSchemaEdit_annotationSetRevisionId_fkey',
          columns: ['annotationSetRevisionId'],
          references: { schema: 'public', table: 'annotationSetRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'conversationalSchemaEdit',
        foreignKey: {
          name: 'conversationalSchemaEdit_promptRevisionId_fkey',
          columns: ['promptRevisionId'],
          references: { schema: 'public', table: 'promptRevision', columns: ['id'] },
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
          name: 'extraction_batch_member_fkey',
          columns: ['batchExtractionId', 'sourceDocumentId', 'sourceRepresentationRevisionId'],
          references: {
            schema: 'public',
            table: 'batchExtractionMember',
            columns: ['batchExtractionId', 'sourceDocumentId', 'sourceRepresentationRevisionId'],
          },
          onDelete: 'restrict',
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
        table: 'extraction',
        foreignKey: {
          name: 'extraction_retry_pin_fkey',
          columns: ['retryOfId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
          references: {
            schema: 'public',
            table: 'extraction',
            columns: ['id', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
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
        table: 'promptRevision',
        foreignKey: {
          name: 'promptRevision_extractionSchemaId_fkey',
          columns: ['extractionSchemaId'],
          references: { schema: 'public', table: 'extractionSchema', columns: ['id'] },
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
        table: 'schemaRevision',
        foreignKey: {
          name: 'schemaRevision_schemaSuggestionId_fkey',
          columns: ['schemaSuggestionId'],
          references: { schema: 'public', table: 'schemaSuggestion', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaRevision',
        foreignKey: {
          name: 'schemaRevision_conversationalSchemaEditId_fkey',
          columns: ['conversationalSchemaEditId'],
          references: { schema: 'public', table: 'conversationalSchemaEdit', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestion',
        foreignKey: {
          name: 'schemaSuggestion_extractionSchemaId_fkey',
          columns: ['extractionSchemaId'],
          references: { schema: 'public', table: 'extractionSchema', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestion',
        foreignKey: {
          name: 'schemaSuggestion_promptRevisionId_fkey',
          columns: ['promptRevisionId'],
          references: { schema: 'public', table: 'promptRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestionInput',
        foreignKey: {
          name: 'schemaSuggestionInput_schemaSuggestionId_fkey',
          columns: ['schemaSuggestionId'],
          references: { schema: 'public', table: 'schemaSuggestion', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestionInput',
        foreignKey: {
          name: 'schemaSuggestionInput_sourceRepresentationRevisionId_fkey',
          columns: ['sourceRepresentationRevisionId'],
          references: { schema: 'public', table: 'sourceRepresentationRevision', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestionInput',
        foreignKey: {
          name: 'schemaSuggestionInput_annotationSetRevisionId_fkey',
          columns: ['annotationSetRevisionId'],
          references: { schema: 'public', table: 'annotationSetRevision', columns: ['id'] },
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
