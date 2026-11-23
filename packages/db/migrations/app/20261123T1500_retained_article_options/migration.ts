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
      id: 'retired-contracts.retained-article-options',
      invariantId: 'retired-contracts.retained-article-options',
      label: 'Remove the retired Article controls from retained resolved options and configurations, so Resume and Retry run',
      operationClass: 'data' as const,
      target: { id: 'postgres' as const, details: { schema: 'extraction_runtime', objectType: 'table' as const, name: 'selection' } },
      precheck: [{ description: 'no Extraction is queued or running; let them finish before migrating', sql: "SELECT NOT EXISTS (SELECT FROM extraction_runtime.head WHERE acknowledgement IN ('QUEUED','RUNNING')) AS ok" }],
      execute: [{ description: 'strip the retired Article controls from resolved options and configurations', sql: readFileSync(new URL('./strip-options.sql', import.meta.url), 'utf8') }],
      postcheck: [{ description: 'no resolved Article options or configuration names a retired control, and each configuration keeps its digest and immutability guards', sql: readFileSync(new URL('./current-options.sql', import.meta.url), 'utf8') }],
    }];
  }
}

MigrationCLI.run(import.meta.url, M);
