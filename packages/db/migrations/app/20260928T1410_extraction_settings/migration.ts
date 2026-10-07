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
      this.addColumn({
        schema: 'public',
        table: 'batchExtraction',
        column: col('requestedModels', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'batchExtraction',
        column: col('requestedSettings', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'extraction',
        column: col('requestedSettings', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
      }),
      // Every valid stored account document gains the empty advanced settings (service defaults); its connections, routes
      // and model choices are untouched. A malformed document is not an object and keeps its visible server fault on
      // read. A document that already has the member is left alone, so the transform's postcheck holds after a rerun.
      this.dataTransform(contract, 'empty-extraction-settings', {
        check: () =>
          sql.public.modelConfiguration
            .select((fields) => ({ researcherAccountId: fields.researcherAccountId }))
            .where((fields, fns) =>
              fns.raw`jsonb_typeof(${fields.document}) = 'object' AND (${fields.document} -> 'extractionSettings') IS NULL`
                .returns('pg/bool@1'))
            .limit(1),
        run: () =>
          sql.public.modelConfiguration
            .update((fields, fns) => ({
              document: fns.raw`${fields.document} || '{"extractionSettings": {}}'::jsonb`.returns('pg/jsonb@1'),
            }))
            .where((fields, fns) =>
              fns.raw`jsonb_typeof(${fields.document}) = 'object' AND (${fields.document} -> 'extractionSettings') IS NULL`
                .returns('pg/bool@1')),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
