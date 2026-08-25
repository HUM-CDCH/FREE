import { createExportFilename, type ExportFormat } from "./filename.js";
import {
  assertExportFormat,
  deliverTable,
  resolveExportChoices,
} from "./spreadsheet.js";
import { buildExportTable, type ExportChoices, type Table } from "./table.js";
import type { SchemaNode } from "extraction/schema";

/** One Batch Extraction member's Extraction Result and its stable Source Document identity. */
export interface BatchExportMember {
  readonly sourceDocumentId: string;
  readonly sourceDocumentName: string;
  readonly result: unknown;
}

const SOURCE_DOCUMENT_COLUMN = "Source Document";
const SOURCE_DOCUMENT_ID_COLUMN = "Source Document ID";
const BATCH_EXTRACTION_ID_COLUMN = "Batch Extraction ID";

/** The canonical persisted Extraction Result is exactly one records envelope. */
function extractionRecords(result: unknown): readonly Record<string, unknown>[] {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    !Array.isArray((result as { records?: unknown }).records) ||
    !(result as { records: unknown[] }).records.every(
      (record) =>
        typeof record === "object" && record !== null && !Array.isArray(record),
    )
  ) {
    throw new TypeError(
      "Batch Extraction Result must contain exactly one records array of objects.",
    );
  }
  return (result as { records: Record<string, unknown>[] }).records;
}

/** Schema fields keep their names; provenance columns move to an unused suffix. */
function provenanceColumn(base: string, columns: readonly string[]): string {
  let column = base;
  for (let ordinal = 2; columns.includes(column); ordinal += 1)
    column = `${base} (${ordinal})`;
  return column;
}

/**
 * One table over a Batch Extraction's members. Every member is projected through
 * the batch's single pinned schema, so the columns are shared and each row names
 * the Source Document its values were extracted from.
 */
export function buildBatchExportTable(
  nodes: readonly SchemaNode[],
  members: readonly BatchExportMember[],
  choices: ExportChoices,
  batchExtractionId: string,
): Table {
  const projected = members.map((member) => ({
    member,
    table: buildExportTable(nodes, extractionRecords(member.result), choices),
  }));
  const columns: string[] = [];
  for (const { table } of projected)
    for (const column of table.columns)
      if (!columns.includes(column)) columns.push(column);
  const provenanceColumns: string[] = [];
  for (const base of [
    SOURCE_DOCUMENT_COLUMN,
    SOURCE_DOCUMENT_ID_COLUMN,
    BATCH_EXTRACTION_ID_COLUMN,
  ])
    provenanceColumns.push(provenanceColumn(base, [...columns, ...provenanceColumns]));
  const [sourceDocumentColumn, sourceDocumentIdColumn, batchExtractionIdColumn] =
    provenanceColumns as [string, string, string];
  return {
    columns: [...provenanceColumns, ...columns],
    rows: projected.flatMap(({ member, table }) =>
      table.rows.map((row) => ({
        ...row,
        [sourceDocumentColumn]: member.sourceDocumentName,
        [sourceDocumentIdColumn]: member.sourceDocumentId,
        [batchExtractionIdColumn]: batchExtractionId,
      })),
    ),
  };
}

export interface ExportBatchExtractionResultsOptions {
  readonly format: ExportFormat;
  /** Names the download. The export replaces its extension. */
  readonly filename: string;
  /** The Schema Revision the Batch Extraction pinned. */
  readonly schemaNodes: readonly SchemaNode[];
  /** Stable identity carried into every exported row. */
  readonly batchExtractionId: string;
  readonly choices?: Partial<ExportChoices>;
}

/**
 * Exports a Batch Extraction's Extraction Results as one spreadsheet download.
 * Members without a result are absent rather than empty rows.
 */
export async function exportBatchExtractionResults(
  members: readonly BatchExportMember[],
  options: ExportBatchExtractionResultsOptions,
): Promise<void> {
  assertExportFormat(options.format);
  const choices = resolveExportChoices(options.schemaNodes, options.choices);
  const table = buildBatchExportTable(
    options.schemaNodes,
    members,
    choices,
    options.batchExtractionId,
  );
  await deliverTable(
    table,
    options.format,
    createExportFilename(
      options.filename,
      options.format,
      "batch-extraction-results",
    ),
  );
}
