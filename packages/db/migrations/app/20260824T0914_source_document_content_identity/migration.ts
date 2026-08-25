#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropIndex({
        schema: 'public',
        table: 'sourceDocument',
        index: 'sourceDocument_contentSha256_idx',
      }),
      // Content identity intentionally replaces duplicate uploads. Existing
      // pre-release databases that contain duplicates must be reset; guessing
      // how to merge their revision and ingestion histories would corrupt the
      // domain model and violates this repository's no-compatibility policy.
      this.addUnique({
        schema: 'public',
        table: 'sourceDocument',
        constraint: 'sourceDocument_projectContextId_contentSha256_key',
        columns: ['projectContextId', 'contentSha256'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
