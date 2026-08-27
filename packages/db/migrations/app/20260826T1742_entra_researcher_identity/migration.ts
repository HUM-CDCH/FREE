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
      // This cutover deliberately has no data mapping. A row on either side
      // means the operator has not completed the documented backup-and-delete
      // step. The no-op update leaves the check true, so the data transform
      // fails its postcheck and PostgreSQL rolls the whole migration back.
      this.dataTransform(contract, 'require-empty-auth-cutover', {
        check: () =>
          sql.public.researcherAccount
            .outerFullJoin(
              sql.public.projectContext,
              (fields, functions) =>
                functions.eq(
                  fields.researcherAccount.id,
                  fields.projectContext.researcherAccountId,
                ),
            )
            .select((fields) => ({
              researcherAccountId: fields.researcherAccount.id,
              projectContextId: fields.projectContext.id,
            }))
            .limit(1),
        run: () =>
          sql.public.researcherAccount.update((fields) => ({
            updatedAt: fields.updatedAt,
          })),
      }),
      this.dropColumn({ schema: 'public', table: 'researcherAccount', column: 'disabledAt' }),
      this.dropColumn({
        schema: 'public',
        table: 'researcherAccount',
        column: 'mustChangePassword',
      }),
      this.dropColumn({ schema: 'public', table: 'researcherAccount', column: 'passwordHash' }),
      this.dropColumn({ schema: 'public', table: 'researcherAccount', column: 'sessionVersion' }),
      this.dropConstraint({
        schema: 'public',
        table: 'researcherAccount',
        constraint: 'researcherAccount_email_key',
      }),
      this.dropColumn({ schema: 'public', table: 'researcherAccount', column: 'email' }),
      this.addColumn({
        schema: 'public',
        table: 'researcherAccount',
        column: col('displayName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.setNotNull({ schema: 'public', table: 'researcherAccount', column: 'displayName' }),
      this.addColumn({
        schema: 'public',
        table: 'researcherAccount',
        column: col('objectId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
      }),
      this.setNotNull({ schema: 'public', table: 'researcherAccount', column: 'objectId' }),
      this.addColumn({
        schema: 'public',
        table: 'researcherAccount',
        column: col('tenantId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
      }),
      this.setNotNull({ schema: 'public', table: 'researcherAccount', column: 'tenantId' }),
      this.addUnique({
        schema: 'public',
        table: 'researcherAccount',
        constraint: 'researcherAccount_tenantId_objectId_key',
        columns: ['tenantId', 'objectId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
