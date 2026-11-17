#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from '../20261116T0040_retire_legacy_contracts/end-contract';
import startContract from '../20261116T0040_retire_legacy_contracts/end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';
import postgresStatic from '@prisma-next/postgres/static';

const { contract, sql } = postgresStatic<End>({ contractJson: endContract });

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dataTransform(contract, 'retire-catalog-preferences', {
        check: () => sql.public.modelConfiguration
          .select(fields => ({ researcherAccountId: fields.researcherAccountId }))
          .where((fields, fns) => fns.raw`jsonb_typeof(${fields.document} #> '{extractionSettings,catalog}') = 'object'
            AND (${fields.document} #> '{extractionSettings,catalog}') ?| array['generic','recipe']`.returns('pg/bool@1'))
          .limit(1),
        run: () => sql.public.modelConfiguration
          .update((fields, fns) => ({ document: fns.raw`jsonb_set(${fields.document}, '{extractionSettings,catalog}',
            (${fields.document} #> '{extractionSettings,catalog}') - 'generic' - 'recipe')`.returns('pg/jsonb@1') }))
          .where((fields, fns) => fns.raw`jsonb_typeof(${fields.document} #> '{extractionSettings,catalog}') = 'object'
            AND (${fields.document} #> '{extractionSettings,catalog}') ?| array['generic','recipe']`.returns('pg/bool@1')),
      }),
      this.dropColumn({ schema: 'public', table: 'extraction', column: 'catalogRecipe' }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
