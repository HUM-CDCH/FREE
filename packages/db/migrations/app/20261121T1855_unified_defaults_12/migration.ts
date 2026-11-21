#!/usr/bin/env -S node
import { readFileSync } from 'node:fs';
import type { Contract as End } from '../20261116T0847_unified_catalog/end-contract';
import endContract from '../20261116T0847_unified_catalog/end-contract.json' with { type: 'json' };
import type { Contract as Start } from '../20261116T0847_unified_catalog/end-contract';
import startContract from '../20261116T0847_unified_catalog/end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [{
      id: 'unified-catalog.defaults-12',
      invariantId: 'unified-catalog.defaults-12',
      label: 'Move stored Unified Catalog method pins from defaults 11 to 12; what a run recorded about itself stays',
      operationClass: 'data' as const,
      target: { id: 'postgres' as const, details: { schema: 'public', objectType: 'table' as const, name: 'extraction' } },
      precheck: [{ description: 'no Extraction is queued or running; let them finish before migrating', sql: "SELECT NOT EXISTS (SELECT FROM extraction_runtime.head WHERE acknowledgement IN ('QUEUED','RUNNING')) AS ok" }],
      execute: [{ description: 'rewrite the defaults version in requested settings, selections and resolved configurations', sql: readFileSync(new URL('./adapt-pins.sql', import.meta.url), 'utf8') }],
      postcheck: [{ description: 'every stored Unified Catalog pin names defaults 12, with its digest and its immutability guards', sql: readFileSync(new URL('./current-pins.sql', import.meta.url), 'utf8') }],
    }];
  }
}

MigrationCLI.run(import.meta.url, M);
