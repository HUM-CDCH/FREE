#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma-next/postgres/migration';
import postgresStatic from '@prisma-next/postgres/static';

const { contract, sql } = postgresStatic<End>({ contractJson: endContract });

type Raw = Parameters<Parameters<ReturnType<typeof sql.public.schemaRevision.update>['where']>[0]>[1]['raw'];

/** The scope the one Extraction Strategy every Extraction and Batch Extraction pinned to this revision ran with names
 *  (ARTICLE → document, CATALOG → records); NULL when the revision never ran or ran with both (ambiguous). */
const pinnedScope = (raw: Raw) => raw`(SELECT CASE MIN("pinned"."strategy") WHEN 'ARTICLE' THEN 'document' WHEN 'CATALOG' THEN 'records' END FROM (SELECT "strategy" FROM "public"."extraction" WHERE "extraction"."schemaRevisionId" = "schemaRevision"."id" UNION SELECT "strategy" FROM "public"."batchExtraction" WHERE "batchExtraction"."schemaRevisionId" = "schemaRevision"."id") AS "pinned" HAVING COUNT(DISTINCT "pinned"."strategy") = 1)`;

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'schemaRevision',
        column: col('recordScope', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      // A legacy revision declares the scope of the one task selection it ran with. One that never ran, or ran as both
      // Article and Catalog, stays NULL: ambiguous, so a choice is required before it runs again. A declared scope is
      // never rewritten, and the stored tree is untouched. The check selects only the rows the update would set, so the
      // postcheck holds while ambiguous revisions remain NULL.
      this.dataTransform(contract, 'schema-revision-record-scope', {
        check: () =>
          sql.public.schemaRevision
            .select((fields) => ({ id: fields.id }))
            .where((fields, fns) =>
              fns.raw`${fields.recordScope} IS NULL AND ${pinnedScope(fns.raw).returns('pg/text@1')} IS NOT NULL`
                .returns('pg/bool@1'))
            .limit(1),
        run: () =>
          sql.public.schemaRevision
            .update((fields, fns) => ({ recordScope: pinnedScope(fns.raw).returns('pg/text@1') }))
            .where((fields, fns) =>
              fns.raw`${fields.recordScope} IS NULL AND ${pinnedScope(fns.raw).returns('pg/text@1')} IS NOT NULL`
                .returns('pg/bool@1')),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
