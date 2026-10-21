#!/usr/bin/env -S node
import { readFileSync } from 'node:fs';
import type { Contract as End } from '../20261010T0842_durable_whitespace_recovery/end-contract';
import endContract from '../20261010T0842_durable_whitespace_recovery/end-contract.json' with { type: 'json' };
import type { Contract as Start } from '../20261010T0842_durable_whitespace_recovery/end-contract';
import startContract from '../20261010T0842_durable_whitespace_recovery/end-contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [{
      id: 'extraction-runtime.codex-extraction',
      invariantId: 'extraction-runtime.codex-extraction',
      label: 'Accept isolated Codex calls with an explicit conservative budget',
      operationClass: 'data' as const,
      target: { id: 'postgres' as const, details: { schema: 'extraction_runtime', objectType: 'function' as const, name: 'finalize_input' } },
      precheck: [{ description: 'the fenced output routine exists with its runtime owner', sql: "SELECT EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='extraction_runtime' AND p.proname='finalize_input' AND p.prosecdef AND r.rolname='free_extraction_runtime') AS ok" }],
      execute: [{ description: 'extend provider and input validation for Codex without changing saved calls', sql: readFileSync(new URL('./codex.sql', import.meta.url), 'utf8') }],
      postcheck: [{ description: 'the fenced input routine recognizes the Codex budget policy', sql: "SELECT EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='extraction_runtime' AND p.proname='finalize_input' AND p.prosecdef AND r.rolname='free_extraction_runtime' AND strpos(pg_get_functiondef(p.oid), 'codex:utf8-budget-v1')>0) AS ok" }],
    }];
  }
}

MigrationCLI.run(import.meta.url, M);
