import { createExportFilename, type ExportFormat } from "./filename.js";
import { validateSpreadsheetDimensions } from "./safety.js";
import {
  assertExportFormat,
  deliverTable,
  resolveExportChoices,
} from "./spreadsheet.js";
import {
  buildEvidenceTable,
  buildExtractionTable,
  EVIDENCE_SHEET,
  EXTRACTION_SHEET,
  type ExtractionProvenance,
} from "./provenance.js";
import { buildReviewNotesTable, REVIEW_NOTES_SHEET, type ContestedField } from "./review-notes.js";
import { buildExportTable, ROOT_ROWS, type ExportChoices } from "./table.js";
import type { SchemaNode } from "extraction/schema";

export type { ExportFormat } from "./filename.js";
export type { ContestedField } from "./review-notes.js";
export {
  buildEvidenceTable,
  buildExtractionTable,
  EVIDENCE_SHEET,
  EXTRACTION_SHEET,
  type ClaimOutcome,
  type ExtractionProvenance,
  type ProvenanceClaim,
} from "./provenance.js";
export {
  buildBatchExportTable,
  exportBatchExtractionResults,
  type BatchExportMember,
  type ExportBatchExtractionResultsOptions,
} from "./batch.js";
export {
  buildExportTable,
  createExtractionResultExportControl,
  deriveRowsRepresentOptions,
  ROOT_ROWS,
  type Choice,
  type ExportChoices,
  type ExtractionResultExportControlModel,
  type OtherRepeatedFields,
  type Table,
} from "./table.js";

export interface ExportExtractionResultOptions {
  readonly format: ExportFormat;
  /** Source Document name. The export replaces its extension. */
  readonly filename: string;
  readonly schemaNodes: readonly SchemaNode[];
  readonly choices?: Partial<ExportChoices>;
  /** Fields left empty because their sources disagreed, by path into `result`: listed on the workbook's Review notes
   *  sheet; a CSV, value-only, cannot carry them. */
  readonly contested?: readonly ContestedField[];
  /** The Extraction's identity and its claims: the workbook's Extraction and Evidence sheets. A CSV, value-only,
   *  cannot carry them. */
  readonly provenance?: ExtractionProvenance;
}

/**
 * Exports the visible Extraction Result as a spreadsheet download.
 * The result holds researcher-visible fields only: one record, or many records.
 */
export async function exportExtractionResult(
  result: unknown,
  options: ExportExtractionResultOptions,
): Promise<void> {
  assertExportFormat(options.format);

  const choices = resolveExportChoices(options.schemaNodes, options.choices);
  if (options.format === "xlsx" && choices.rowsRepresent === ROOT_ROWS && Array.isArray(result)) {
    validateSpreadsheetDimensions(result.length, 0);
  }

  const table = buildExportTable(options.schemaNodes, result, choices);
  await deliverTable(
    table,
    options.format,
    createExportFilename(options.filename, options.format),
    [
      ...(options.contested?.length
        ? [{ sheet: REVIEW_NOTES_SHEET, table: buildReviewNotesTable(options.contested) }]
        : []),
      ...(options.provenance
        ? [
            { sheet: EXTRACTION_SHEET, table: buildExtractionTable(options.provenance.identity) },
            { sheet: EVIDENCE_SHEET, table: buildEvidenceTable(options.provenance.claims) },
          ]
        : []),
    ],
  );
}
