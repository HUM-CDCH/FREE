import { serializeCsv } from "./csv.js";
import { downloadBlob } from "./download.js";
import { createExportFilename, type ExportFormat } from "./filename.js";
import { validateSpreadsheetDimensions } from "./safety.js";
import {
  buildExportTable,
  createExtractionResultExportControl,
  ROOT_ROWS,
  type ExportChoices,
} from "./table.js";
import { createXlsxBlob } from "./xlsx.js";
import type { SchemaNode } from "../../../prototypes/studio/shared/schemaNode.js";

export type { ExportFormat } from "./filename.js";
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
}

/**
 * Exports the visible Extraction Result as a spreadsheet download.
 * The result holds researcher-visible fields only: one record, or many records.
 */
export async function exportExtractionResult(
  result: unknown,
  options: ExportExtractionResultOptions,
): Promise<void> {
  if (options.format !== "csv" && options.format !== "xlsx") {
    throw new TypeError(`Unsupported export format: ${String(options.format)}.`);
  }

  const control = createExtractionResultExportControl(options.schemaNodes, options.choices);
  const choices: ExportChoices = {
    rowsRepresent: control.rowsRepresent.value,
    otherRepeatedFields: control.otherRepeatedFields.value,
  };
  if (options.format === "xlsx" && choices.rowsRepresent === ROOT_ROWS && Array.isArray(result)) {
    validateSpreadsheetDimensions(result.length, 0);
  }

  const table = buildExportTable(options.schemaNodes, result, choices);
  const blob =
    options.format === "csv"
      ? new Blob([serializeCsv(table)], { type: "text/csv;charset=utf-8" })
      : await createXlsxBlob(table);

  downloadBlob(blob, createExportFilename(options.filename, options.format));
}
