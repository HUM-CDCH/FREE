#!/usr/bin/env -S node
import { readFileSync } from 'node:fs';
import type { Contract as End } from './end-contract';
import endContract from './end-contract.json' with { type: 'json' };
import type { Contract as Start } from './start-contract';
import startContract from './start-contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma-next/postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'extraction_runtime' }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'artifactReference',
        columns: [
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('generation', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('reference', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'attempt',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('failure', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('fence', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('outcome', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('selectionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('workflowId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'capture',
        columns: [
          col('candidates', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('descriptor', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('feedbackVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('generation', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('inFlight', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('invoked', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('originalAttemptId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('reservationAttemptId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('reservationEpoch', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('selectionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('unitKey', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'checkpoint',
        columns: [
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('inputDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('output', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('outputDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'command',
        columns: [
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('payload', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('response', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'correction',
        columns: [
          col('candidate', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('decision', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('feedbackVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('included', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('projectId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('revision', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('selectionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('snapshotVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('valueId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'dispatch',
        columns: [
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('received', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('workflowId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'effective',
        columns: [
          col('configuration', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'feedbackHead',
        columns: [
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('version', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'finalization',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('decisionDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('feedbackVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('snapshotVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'head',
        columns: [
          col('acknowledgement', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('attemptId', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('controlVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('deleted', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('fence', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('generation', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('intent', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('leaseEpoch', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('leaseOwner', '"uuid"', { codecRef: { codecId: 'pg/uuid@1', typeParams: {} } }),
          col('leaseUntil', 'timestamptz(6)', {
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('pendingResume', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('pendingSelectionId', '"uuid"', {
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('projectId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('selectionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('snapshotVersion', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('sourcePin', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('sourceRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('strategy', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'input',
        columns: [
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('request', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'legacyIdentity',
        columns: [
          col('artifactDigest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('path', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'plan',
        columns: [
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('generation', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('manifest', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('stage', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'protocol',
        columns: [
          col('id', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('version', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'selection',
        columns: [
          col('createdAt', 'timestamptz(6)', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz@1', typeParams: { precision: 6 } },
          }),
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('method', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('ordinal', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('resolved', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('schemaHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('schemaRevisionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('schemaTree', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'extraction_runtime',
        table: 'snapshot',
        columns: [
          col('coverage', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('digest', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('extractionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('id', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('selectionId', '"uuid"', {
            notNull: true,
            codecRef: { codecId: 'pg/uuid@1', typeParams: {} },
          }),
          col('values', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('version', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'attempt',
        constraint: 'attempt_workflowId_key',
        columns: ['workflowId'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'attempt',
        constraint: 'attempt_extractionId_fence_key',
        columns: ['extractionId', 'fence'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'capture',
        constraint: 'capture_extractionId_generation_unitKey_key',
        columns: ['extractionId', 'generation', 'unitKey'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'correction',
        constraint: 'correction_extractionId_valueId_revision_key',
        columns: ['extractionId', 'valueId', 'revision'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'dispatch',
        constraint: 'dispatch_workflowId_key',
        columns: ['workflowId'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'finalization',
        constraint: 'finalization_extractionId_snapshotVersion_feedbackVersion_key',
        columns: ['extractionId', 'snapshotVersion', 'feedbackVersion'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'plan',
        constraint: 'plan_extractionId_generation_stage_key',
        columns: ['extractionId', 'generation', 'stage'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'selection',
        constraint: 'selection_extractionId_ordinal_key',
        columns: ['extractionId', 'ordinal'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'selection',
        constraint: 'selection_id_extractionId_key',
        columns: ['id', 'extractionId'],
      }),
      this.addUnique({
        schema: 'extraction_runtime',
        table: 'snapshot',
        constraint: 'snapshot_extractionId_version_key',
        columns: ['extractionId', 'version'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'artifactReference',
        index: 'artifactReference_reference_idx',
        columns: ['reference'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'artifactReference',
        index: 'artifactReference_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'attempt',
        index: 'attempt_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'capture',
        index: 'capture_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'command',
        index: 'command_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'correction',
        index: 'correction_projectId_feedbackVersion_idx',
        columns: ['projectId', 'feedbackVersion'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'correction',
        index: 'correction_projectId_idx',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'finalization',
        index: 'finalization_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'head',
        index: 'head_projectId_idx',
        columns: ['projectId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'legacyIdentity',
        index: 'legacyIdentity_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'plan',
        index: 'plan_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'selection',
        index: 'selection_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.createIndex({
        schema: 'extraction_runtime',
        table: 'snapshot',
        index: 'snapshot_extractionId_idx',
        columns: ['extractionId'],
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'artifactReference',
        foreignKey: {
          name: 'artifactReference_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'attempt',
        foreignKey: {
          name: 'attempt_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'capture',
        foreignKey: {
          name: 'capture_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'checkpoint',
        foreignKey: {
          name: 'checkpoint_id_fkey',
          columns: ['id'],
          references: { schema: 'extraction_runtime', table: 'capture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'command',
        foreignKey: {
          name: 'command_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'correction',
        foreignKey: {
          name: 'correction_projectId_fkey',
          columns: ['projectId'],
          references: { schema: 'extraction_runtime', table: 'feedbackHead', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'dispatch',
        foreignKey: {
          name: 'dispatch_id_fkey',
          columns: ['id'],
          references: { schema: 'extraction_runtime', table: 'attempt', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'effective',
        foreignKey: {
          name: 'effective_id_fkey',
          columns: ['id'],
          references: { schema: 'extraction_runtime', table: 'selection', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'finalization',
        foreignKey: {
          name: 'finalization_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'input',
        foreignKey: {
          name: 'input_id_fkey',
          columns: ['id'],
          references: { schema: 'extraction_runtime', table: 'capture', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'plan',
        foreignKey: {
          name: 'plan_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'selection',
        foreignKey: {
          name: 'selection_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'extraction_runtime',
        table: 'snapshot',
        foreignKey: {
          name: 'snapshot_extractionId_fkey',
          columns: ['extractionId'],
          references: { schema: 'extraction_runtime', table: 'head', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      {
        id: 'extraction-runtime.protocol-1', label: 'Install restricted Extraction protocol 1 routines', operationClass: 'additive' as const,
        target: { id: 'postgres' as const, details: { schema: 'extraction_runtime', objectType: 'table' as const, name: 'protocol' } },
        precheck: [{ description: 'protocol is not installed', sql: 'SELECT NOT EXISTS (SELECT FROM extraction_runtime.protocol WHERE id = 1) AS ok' }],
        execute: [{ description: 'install protocol and narrow routine ownership', sql: readFileSync(new URL('./runtime.sql', import.meta.url), 'utf8') }],
        postcheck: [{ description: 'protocol 1 is installed', sql: 'SELECT EXISTS (SELECT FROM extraction_runtime.protocol WHERE id = 1 AND version = 1) AS ok' }],
      },
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
