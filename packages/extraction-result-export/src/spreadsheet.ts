import { serializeCsv } from "./csv.js";
import { downloadBlob } from "./download.js";
import type { ExportFormat } from "./filename.js";
import {
  createExtractionResultExportControl,
  type ExportChoices,
  type Table,
} from "./table.js";
import { createXlsxBlob, type CompanionSheet } from "./xlsx.js";
import type { SchemaNode } from "extraction/schema";

/** Rejects a format before any result is read, so no work is wasted. */
export function assertExportFormat(format: ExportFormat): void {
  if (format !== "csv" && format !== "xlsx")
    throw new TypeError(`Unsupported export format: ${String(format)}.`);
}

/** The schema-led choices, defaulted and validated against the pinned schema. */
export function resolveExportChoices(
  nodes: readonly SchemaNode[],
  choices: Partial<ExportChoices> | undefined,
): ExportChoices {
  const control = createExtractionResultExportControl(nodes, choices);
  return {
    rowsRepresent: control.rowsRepresent.value,
    otherRepeatedFields: control.otherRepeatedFields.value,
  };
}

/** Serializes one table in the chosen format and starts its download. CSV holds the values alone, so `companions`
 *  (the Review notes of contested fields; an Extraction's Extraction and Evidence sheets) reach only a workbook. */
export async function deliverTable(
  table: Table,
  format: ExportFormat,
  filename: string,
  companions?: readonly CompanionSheet[],
): Promise<void> {
  const blob =
    format === "csv"
      ? new Blob([serializeCsv(table)], { type: "text/csv;charset=utf-8" })
      : await createXlsxBlob(table, companions);
  downloadBlob(blob, filename);
}
