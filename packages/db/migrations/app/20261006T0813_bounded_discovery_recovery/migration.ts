#!/usr/bin/env -S node
import { readFileSync } from 'node:fs';
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'extraction_runtime',
        table: 'callFailure',
        column: col('recoverable', 'bool', {
          notNull: true,
          default: lit(false),
          codecRef: { codecId: 'pg/bool@1' },
        }),
      }),
      {
        id: 'extraction-runtime.bounded-discovery-recovery',
        label: 'Allow bounded unified fallback for output-limit replies',
        operationClass: 'additive' as const,
        target: { id: 'postgres' as const, details: { schema: 'extraction_runtime', objectType: 'table' as const, name: 'callFailure' } },
        precheck: [{ description: 'attempt-local failure policy exists', sql: "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema='extraction_runtime' AND table_name='callFailure' AND column_name='recoverable') AS ok" }],
        execute: [{ description: 'install bounded recovery without changing worker privileges', sql: readFileSync(new URL('./recovery.sql', import.meta.url), 'utf8') }],
        postcheck: [{ description: 'bounded recovery is installed under its restricted definer', sql: "SELECT EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='extraction_runtime' AND p.proname='commit_output' AND p.prosecdef AND r.rolname='free_extraction_runtime' AND strpos(pg_get_functiondef(p.oid),'recover :=')>0) AS ok" }],
      },
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
