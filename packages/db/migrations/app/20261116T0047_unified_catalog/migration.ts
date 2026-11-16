#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from '../20261103T1256_project_chat/end-contract';
import startContract from '../20261103T1256_project_chat/end-contract.json' with { type: 'json' };
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
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
