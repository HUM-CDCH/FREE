#!/usr/bin/env -S node
import { readFileSync } from 'node:fs';
import type { Contract as Start } from '../20261010T0842_durable_whitespace_recovery/end-contract';
import type { Contract as End } from '../20261010T0842_durable_whitespace_recovery/end-contract';
import startContract from '../20261010T0842_durable_whitespace_recovery/end-contract.json' with { type: 'json' };
import endContract from '../20261010T0842_durable_whitespace_recovery/end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;
  override get operations() {
    return [{
      id: 'extraction-runtime.value-disagreement',
      invariantId: 'extraction-runtime.value-disagreement',
      label: 'Keep disagreeing typed readings in retained values',
      operationClass: 'data' as const,
      target: { id: 'postgres' as const, details: { schema: 'extraction_runtime', objectType: 'function' as const, name: 'publish_snapshot' } },
      precheck: [{ description: 'the fenced publisher exists with its runtime owner', sql: "SELECT EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='extraction_runtime' AND p.proname='publish_snapshot' AND p.prosecdef AND r.rolname='free_extraction_runtime') AS ok" }],
      execute: [{ description: 'validate Value Disagreements on publication', sql: readFileSync(new URL('./disagreement.sql', import.meta.url), 'utf8') }],
      postcheck: [{ description: 'the publisher validates disagreements with a runtime-owned helper', sql: "SELECT EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='extraction_runtime' AND p.proname='publish_snapshot' AND strpos(pg_get_functiondef(p.oid),'valid_disagreement(')>0) AND EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='extraction_runtime' AND p.proname='valid_disagreement' AND r.rolname='free_extraction_runtime') AS ok" }],
    }];
  }
}
MigrationCLI.run(import.meta.url, M);
