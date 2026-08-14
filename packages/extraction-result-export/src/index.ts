import { serializeCsv } from "./csv.js";
import { downloadBlob } from "./download.js";
import { createExportFilename, type ExportFormat } from "./filename.js";
import { validateSpreadsheetDimensions } from "./safety.js";
import { toTable } from "./table.js";
import { createXlsxBlob } from "./xlsx.js";

export type { ExportFormat } from "./filename.js";

export interface ExportExtractionResultOptions {
  readonly format: ExportFormat;
  /** Source Document name. The export replaces its extension. */
  readonly filename: string;
  /**
   * Extraction Schema fields as flattened paths, in schema order. They lead the
   * columns. A path escapes `.` and `\` in an original field name, as in `a\.b`;
   * numeric object keys use `\0`, while array indexes keep `0`.
   */
  readonly columns?: readonly string[];
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

  if (options.format === "xlsx" && Array.isArray(result)) {
    validateSpreadsheetDimensions(result.length, 0);
  }

  const table = toTable(result, options.columns);
  const blob =
    options.format === "csv"
      ? new Blob([serializeCsv(table)], { type: "text/csv;charset=utf-8" })
      : await createXlsxBlob(table);

  downloadBlob(blob, createExportFilename(options.filename, options.format));
}
