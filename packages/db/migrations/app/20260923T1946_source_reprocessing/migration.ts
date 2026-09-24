#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        column: col('reprocessFingerprint', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        column: col('reprocessKey', '"uuid"', {
          codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
        }),
      }),
      this.addUnique({
        schema: 'public',
        table: 'sourceRepresentationRevision',
        constraint: 'sourceRepresentationRevision_sourceDocumentId_reprocessKey_key',
        columns: ['sourceDocumentId', 'reprocessKey'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
