#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma-next/postgres/migration';
import postgresStatic from '@prisma-next/postgres/static';

const { contract, sql } = postgresStatic<End>({ contractJson: endContract });

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropConstraint({
        schema: 'public',
        table: 'extractionReview',
        constraint: 'extractionReview_extractionId_key',
      }),

      this.addColumn({
        schema: 'public',
        table: 'extractionReview',
        column: col('revisionNumber', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
      }),
      this.dataTransform(contract, 'backfill-extractionReview-revisionNumber', {
        check: () =>
          sql.public.extractionReview
            .select('id')
            .where((fields, functions) => functions.eq(fields.revisionNumber, null))
            .limit(1),
        run: () => sql.public.extractionReview.update({ revisionNumber: 1 }),
      }),
      this.setNotNull({ schema: 'public', table: 'extractionReview', column: 'revisionNumber' }),
      this.addColumn({
        schema: 'public',
        table: 'reviewDecision',
        column: col('extractionReviewId', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      this.dataTransform(contract, 'backfill-reviewDecision-extractionReviewId', {
        check: () =>
          sql.public.reviewDecision
            .select('id')
            .where((fields, functions) => functions.eq(fields.extractionReviewId, null))
            .limit(1),
        run: () =>
          sql.public.reviewDecision.update((_fields, functions) => ({
            extractionReviewId: functions.raw`
              (SELECT "id"
               FROM "public"."extractionReview"
               WHERE "extractionReview"."extractionId" = "reviewDecision"."extractionId")
            `.returns({ codecId: 'pg/uuid@1', nullable: true }),
          })),
      }),
      this.setNotNull({ schema: 'public', table: 'reviewDecision', column: 'extractionReviewId' }),
      this.dropConstraint({
        schema: 'public',
        table: 'reviewDecision',
        constraint: 'reviewDecision_extractionId_fkey',
        kind: 'foreignKey',
      }),
      this.dropIndex({
        schema: 'public',
        table: 'reviewDecision',
        index: 'reviewDecision_extractionId_idx',
      }),
      this.dropConstraint({
        schema: 'public',
        table: 'reviewDecision',
        constraint: 'reviewDecision_extractionId_resultPathKey_key',
      }),
      this.dropColumn({ schema: 'public', table: 'reviewDecision', column: 'extractionId' }),
      this.addUnique({
        schema: 'public',
        table: 'extractionReview',
        constraint: 'extractionReview_extractionId_revisionNumber_key',
        columns: ['extractionId', 'revisionNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'reviewDecision',
        constraint: 'reviewDecision_extractionReviewId_resultPathKey_key',
        columns: ['extractionReviewId', 'resultPathKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'extractionReview',
        index: 'extractionReview_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'reviewDecision',
        index: 'reviewDecision_extractionReviewId_idx',
        columns: ['extractionReviewId'],
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
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
