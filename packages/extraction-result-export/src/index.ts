/**
 * The researcher's spreadsheet export: a schema-led table (schema fields as columns, one row per record or per
 * selected repeated object) written as CSV or XLSX with formula protection and the Excel limits enforced. Durable
 * Extractions project their fixed saved values through the same table (apps/studio/src/durableExport.ts).
 */
export type { ExportFormat } from "./filename.js";
export { createExportFilename } from "./filename.js";
export { downloadBlob } from "./download.js";
export { createXlsxBlob, type CompanionSheet } from "./xlsx.js";
export { serializeCsv } from "./csv.js";
export { validateSpreadsheetDimensions } from "./safety.js";
export {
  buildExportTable,
  createExtractionResultExportControl,
  deriveRowsRepresentOptions,
  ROOT_ROWS,
  type CellValue,
  type Choice,
  type ExportChoices,
  type ExtractionResultExportControlModel,
  type OtherRepeatedFields,
  type Table,
} from "./table.js";
export {
  buildDurableEvidenceTable,
  buildDurableExportTable,
  buildIdentityTable,
  conform,
  createFieldRegistry,
  DOCUMENT_RECORD,
  durableRecords,
  durableSchemaNodes,
  EVIDENCE_SHEET,
  exportedValue,
  EXTRACTION_SHEET,
  typeWords,
  type DurableExportValue,
  type DurableRecord,
  type FieldRegistry,
} from "./durable.js";
