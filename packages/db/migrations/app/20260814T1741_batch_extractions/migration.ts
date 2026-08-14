#!/usr/bin/env -S node
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, rawSql } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      rawSql({
        id: 'batch-extractions.create-pinned-batch-schema',
        label: 'Create pinned Batch Extraction storage',
        operationClass: 'additive',
        target: { id: 'postgres' },
        precheck: [],
        execute: [{
          description: 'Create batch tables, pins, and indexes',
          sql: `CREATE TABLE public."batchExtraction" (
              "id" uuid NOT NULL,
              "projectContextId" uuid NOT NULL,
              "schemaRevisionId" uuid NOT NULL,
              "strategy" text NOT NULL,
              "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
              PRIMARY KEY ("id"),
              CONSTRAINT "batch_extraction_pin_key"
                UNIQUE ("id", "schemaRevisionId", "strategy")
            );
            CREATE TABLE public."batchExtractionMember" (
              "batchExtractionId" uuid NOT NULL,
              "sourceDocumentId" uuid NOT NULL,
              "sourceRepresentationRevisionId" uuid NOT NULL,
              PRIMARY KEY ("batchExtractionId", "sourceDocumentId"),
              CONSTRAINT "batch_member_exact_pin_key"
                UNIQUE ("batchExtractionId", "sourceDocumentId", "sourceRepresentationRevisionId")
            );
            ALTER TABLE public.extraction
              ADD COLUMN "batchExtractionId" uuid;
            ALTER TABLE public."batchExtraction"
              ADD CONSTRAINT "batchExtraction_projectContextId_fkey"
              FOREIGN KEY ("projectContextId")
              REFERENCES public."projectContext" ("id") ON DELETE CASCADE,
              ADD CONSTRAINT "batchExtraction_schemaRevisionId_fkey"
              FOREIGN KEY ("schemaRevisionId")
              REFERENCES public."schemaRevision" ("id") ON DELETE CASCADE;
            ALTER TABLE public."batchExtractionMember"
              ADD CONSTRAINT "batchExtractionMember_batchExtractionId_fkey"
              FOREIGN KEY ("batchExtractionId")
              REFERENCES public."batchExtraction" ("id") ON DELETE CASCADE,
              ADD CONSTRAINT "batch_member_representation_fkey"
              FOREIGN KEY ("sourceRepresentationRevisionId", "sourceDocumentId")
              REFERENCES public."sourceRepresentationRevision" ("id", "sourceDocumentId") ON DELETE CASCADE;
            ALTER TABLE public.extraction
              ADD CONSTRAINT "extraction_batch_pin_fkey"
              FOREIGN KEY ("batchExtractionId", "schemaRevisionId", "strategy")
              REFERENCES public."batchExtraction" ("id", "schemaRevisionId", "strategy") ON DELETE CASCADE,
              ADD CONSTRAINT "extraction_batch_member_fkey"
              FOREIGN KEY ("batchExtractionId", "sourceDocumentId", "sourceRepresentationRevisionId")
              REFERENCES public."batchExtractionMember" ("batchExtractionId", "sourceDocumentId", "sourceRepresentationRevisionId") ON DELETE RESTRICT;
            CREATE INDEX "batchExtraction_projectContextId_createdAt_idx"
              ON public."batchExtraction" ("projectContextId", "createdAt");
            CREATE INDEX "batchExtraction_projectContextId_idx"
              ON public."batchExtraction" ("projectContextId");
            CREATE INDEX "batchExtraction_schemaRevisionId_idx"
              ON public."batchExtraction" ("schemaRevisionId");
            CREATE INDEX "batchExtractionMember_batchExtractionId_idx"
              ON public."batchExtractionMember" ("batchExtractionId");
            CREATE INDEX "batch_member_representation_idx"
              ON public."batchExtractionMember" ("sourceRepresentationRevisionId", "sourceDocumentId");
            CREATE INDEX "extraction_batchExtractionId_sourceDocumentId_sourceRepresentationRevisionId_idx"
              ON public.extraction ("batchExtractionId", "sourceDocumentId", "sourceRepresentationRevisionId");
            CREATE INDEX "extraction_batch_pin_idx"
              ON public.extraction ("batchExtractionId", "schemaRevisionId", "strategy");`,
        }],
        postcheck: [],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
