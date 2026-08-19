#!/usr/bin/env -S node
import type { Contract as End } from './end-contract'
import endContract from './end-contract.json' with { type: 'json' }
import type { Contract as Start } from './start-contract'
import startContract from './start-contract.json' with { type: 'json' }
import {
  Migration,
  MigrationCLI,
  col,
  rawSql,
} from '@prisma-next/postgres/migration'

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract
  override readonly endContractJson = endContract

  override get operations() {
    return [
      this.dropConstraint({
        schema: 'public',
        table: 'schemaSuggestion',
        constraint: 'schemaSuggestion_extractionSchemaId_fkey',
        kind: 'foreignKey',
      }),
      this.dropCheckConstraint({
        schema: 'public',
        table: 'schemaSuggestion',
        constraint: 'schemaSuggestion_outcome_check',
      }),
      this.addColumn({
        schema: 'public',
        table: 'schemaSuggestion',
        column: col('leaseExpiresAt', 'timestamptz(6)', {
          codecRef: {
            codecId: 'pg/timestamptz@1',
            typeParams: { precision: 6 },
          },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'schemaSuggestion',
        column: col('projectContextId', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'schemaSuggestion',
        column: col('sourceDocumentId', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      rawSql({
        id: 'data.backfill-schema-suggestion-owner',
        label: 'Backfill Schema Suggestion owners',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [
          {
            description:
              'Verify every existing suggestion has an Extraction Schema owner',
            sql: `SELECT NOT EXISTS (
              SELECT 1
              FROM public."schemaSuggestion" AS suggestion
              LEFT JOIN public."extractionSchema" AS schema
                ON schema.id = suggestion."extractionSchemaId"
              WHERE schema.id IS NULL
            ) AS ok`,
          },
        ],
        execute: [
          {
            description:
              'Copy the owning Project Context from each Extraction Schema',
            sql: `UPDATE public."schemaSuggestion" AS suggestion
              SET "projectContextId" = schema."projectContextId"
              FROM public."extractionSchema" AS schema
              WHERE schema.id = suggestion."extractionSchemaId"`,
          },
        ],
        postcheck: [
          {
            description:
              'Verify every suggestion now has a Project Context owner',
            sql: `SELECT NOT EXISTS (
              SELECT 1
              FROM public."schemaSuggestion"
              WHERE "projectContextId" IS NULL
            ) AS ok`,
          },
        ],
      }),
      rawSql({
        id: 'data.remove-obsolete-source-suggestion-cache',
        label: 'Remove obsolete private source suggestion caches',
        operationClass: 'data',
        target: { id: 'postgres' },
        precheck: [],
        execute: [
          {
            description:
              'Delete suggestions owned by the obsolete cache schemas',
            sql: `DELETE FROM public."schemaSuggestion" AS suggestion
              USING public."extractionSchema" AS schema
              WHERE suggestion."extractionSchemaId" = schema.id
                AND schema.name = 'Private Schema Suggestion Cache'`,
          },
          {
            description: 'Delete the obsolete cache schemas',
            sql: `DELETE FROM public."extractionSchema"
              WHERE name = 'Private Schema Suggestion Cache'`,
          },
        ],
        postcheck: [
          {
            description: 'Verify no obsolete cache schema remains',
            sql: `SELECT NOT EXISTS (
              SELECT 1
              FROM public."extractionSchema"
              WHERE name = 'Private Schema Suggestion Cache'
            ) AS ok`,
          },
        ],
      }),
      this.setNotNull({
        schema: 'public',
        table: 'schemaSuggestion',
        column: 'projectContextId',
      }),
      this.dropNotNull({
        schema: 'public',
        table: 'schemaSuggestion',
        column: 'extractionSchemaId',
      }),
      this.addUnique({
        schema: 'public',
        table: 'extractionSchema',
        constraint: 'extraction_schema_owner_key',
        columns: ['id', 'projectContextId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceDocument',
        constraint: 'source_document_owner_key',
        columns: ['id', 'projectContextId'],
      }),
      this.addCheckConstraint({
        schema: 'public',
        table: 'schemaSuggestion',
        constraint: 'schemaSuggestion_outcome_check',
        column: 'outcome',
        values: ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestion',
        index: 'schemaSuggestion_extractionSchemaId_projectContextId_idx',
        columns: ['extractionSchemaId', 'projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestion',
        index: 'schemaSuggestion_projectContextId_idx',
        columns: ['projectContextId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'schemaSuggestion',
        index: 'schemaSuggestion_sourceDocumentId_projectContextId_idx',
        columns: ['sourceDocumentId', 'projectContextId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestion',
        foreignKey: {
          name: 'schema_suggestion_schema_owner_fkey',
          columns: ['extractionSchemaId', 'projectContextId'],
          references: {
            schema: 'public',
            table: 'extractionSchema',
            columns: ['id', 'projectContextId'],
          },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestion',
        foreignKey: {
          name: 'schema_suggestion_source_owner_fkey',
          columns: ['sourceDocumentId', 'projectContextId'],
          references: {
            schema: 'public',
            table: 'sourceDocument',
            columns: ['id', 'projectContextId'],
          },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'schemaSuggestion',
        foreignKey: {
          name: 'schemaSuggestion_projectContextId_fkey',
          columns: ['projectContextId'],
          references: {
            schema: 'public',
            table: 'projectContext',
            columns: ['id'],
          },
          onDelete: 'cascade',
        },
      }),
    ]
  }
}

MigrationCLI.run(import.meta.url, M)
