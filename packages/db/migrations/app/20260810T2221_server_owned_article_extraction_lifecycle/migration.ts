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
  primaryKey,
  rawSql,
} from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'data.reset-incompatible-extraction-state',
        label: 'Delete incompatible prototype extraction state',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [{
          description: 'Delete incompatible extraction and review rows',
          sql: `DELETE FROM public."reviewDecision";
            DELETE FROM public.extraction;`,
        }],
        postcheck: [],
      }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'rawModelOutput' }),
      this.dropConstraint({
        schema: 'public',
        table: 'extraction',
        constraint: 'extraction_sourceRepresentationRevisionId_fkey',
        kind: 'foreignKey',
      }),
      this.dropIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_sourceRepresentationRevisionId_idx',
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
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('complete', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('evidenceLinks', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('retryOfId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('reviewedAt', 'timestamptz(6)', {
          codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('diagnostics', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
      }),
      this.setNotNull({ schema: 'public', table: 'extraction', column: 'diagnostics' }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('reviewable', 'bool', { codecRef: { codecId: 'pg/bool@1' } }),
      }),
      this.setNotNull({ schema: 'public', table: 'extraction', column: 'reviewable' }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('sourceDocumentId', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      this.setNotNull({ schema: 'public', table: 'extraction', column: 'sourceDocumentId' }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('strategy', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.setNotNull({ schema: 'public', table: 'extraction', column: 'strategy' }),
      this.dropNotNull({ schema: 'public', table: 'extraction', column: 'modelAttribution' }),
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
        table: 'sourceRepresentationRevision',
        constraint: 'sourceRepresentationRevision_id_sourceDocumentId_key',
        columns: ['id', 'sourceDocumentId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_retry_pin_idx',
        columns: ['retryOfId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy'],
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
        index: 'extraction_sourceDocumentId_createdAt_idx',
        columns: ['sourceDocumentId', 'createdAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extraction',
        index: 'extraction_sourceRepresentationRevisionId_sourceDocumentId_idx',
        columns: ['sourceRepresentationRevisionId', 'sourceDocumentId'],
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
          onDelete: 'restrict',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'extractionReview',
        foreignKey: {
          name: 'extractionReview_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'public', table: 'extraction', columns: ['id'] },
          onDelete: 'restrict',
        },
      }),
      rawSql({
        id: 'constraint.article-terminal-shape',
        label: 'Enforce Article strategy and terminal shapes',
        operationClass: 'additive',
        target: { id: 'postgres', details: { schema: 'public', objectType: 'constraint', name: 'extraction_terminal_shape_check', table: 'extraction' } },
        precheck: [],
        execute: [{
          description: 'Install Article lifecycle and JSON shape checks',
          sql: `ALTER TABLE public.extraction
            ADD CONSTRAINT extraction_strategy_check CHECK (strategy = 'ARTICLE'),
            ADD CONSTRAINT extraction_terminal_shape_check CHECK (
              jsonb_typeof(diagnostics) = 'object'
              AND ("modelAttribution" IS NULL OR jsonb_typeof("modelAttribution") = 'object')
              AND (failure IS NULL OR jsonb_typeof(failure) = 'object')
              AND ("retryOfId" IS NULL OR "retryOfId" <> id)
              AND (
                (outcome = 'SUCCEEDED' AND complete IS NOT NULL AND "resultPayload" IS NOT NULL
                  AND jsonb_typeof("resultPayload") = 'object' AND "evidenceLinks" IS NOT NULL
                  AND jsonb_typeof("evidenceLinks") = 'array' AND failure IS NULL
                  AND "modelAttribution" IS NOT NULL)
                OR
                (outcome = 'FAILED' AND complete IS NULL AND failure IS NOT NULL
                  AND "resultPayload" IS NULL AND "evidenceLinks" IS NULL
                  AND reviewable = false AND "reviewedAt" IS NULL)
                OR
                (outcome = 'CANCELLED' AND complete IS NULL AND failure IS NULL
                  AND "resultPayload" IS NULL AND "evidenceLinks" IS NULL
                  AND reviewable = false AND "reviewedAt" IS NULL)
              )
              AND ("reviewedAt" IS NULL OR (outcome = 'SUCCEEDED' AND reviewable = true))
            );
            ALTER TABLE public."reviewDecision"
              ADD CONSTRAINT review_decision_occurrences_array_check
              CHECK (jsonb_typeof("reviewedOccurrenceIds") = 'array');`,
        }],
        postcheck: [],
      }),
      rawSql({
        id: 'constraint.extraction-append-only',
        label: 'Make the Extraction lifecycle append-only',
        operationClass: 'additive',
        target: { id: 'postgres', details: { schema: 'public', objectType: 'trigger', name: 'extraction_append_only', table: 'extraction' } },
        precheck: [],
        execute: [{
          description: 'Protect attempts, review gates, and Review Decisions',
          sql: `CREATE FUNCTION public.free_extraction_append_only() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
              IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Extraction rows are append-only'; END IF;
              IF OLD."reviewedAt" IS NOT NULL OR NEW."reviewedAt" IS NULL
                OR (to_jsonb(NEW) - 'reviewedAt') <> (to_jsonb(OLD) - 'reviewedAt')
              THEN RAISE EXCEPTION 'Only reviewedAt may be finalized once'; END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER extraction_append_only BEFORE UPDATE OR DELETE ON public.extraction
              FOR EACH ROW EXECUTE FUNCTION public.free_extraction_append_only();
            CREATE FUNCTION public.free_review_decision_append_only() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Review Decisions are append-only'; END $$;
            CREATE TRIGGER review_decision_append_only BEFORE UPDATE OR DELETE ON public."reviewDecision"
              FOR EACH ROW EXECUTE FUNCTION public.free_review_decision_append_only();
            CREATE FUNCTION public.free_extraction_review_append_only() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Extraction Reviews are append-only'; END $$;
            CREATE TRIGGER extraction_review_append_only BEFORE UPDATE OR DELETE ON public."extractionReview"
              FOR EACH ROW EXECUTE FUNCTION public.free_extraction_review_append_only();`,
        }],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
