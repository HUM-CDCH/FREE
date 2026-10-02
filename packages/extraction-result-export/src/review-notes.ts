import { fieldName } from "./provenance.js";
import type { CellValue, Table } from "./table.js";

/**
 * A value the service left empty because its sources disagreed. The Results sheet keeps the empty cell (the export
 * is value-only); the workbook's Review notes sheet lists the candidates. `record` is the 0-based record the value
 * belongs to, when the result holds several; `path` is the field's path inside it.
 */
export interface ContestedField {
  readonly record?: number;
  readonly path: readonly (string | number)[];
  readonly candidates: readonly unknown[];
}

export const REVIEW_NOTES_SHEET = "Review notes";
const NOTE = "Sources disagreed; left empty in Results";

const candidateCell = (value: unknown): CellValue =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : JSON.stringify(value);

/** The Review notes table: one row per contested field, after any leading provenance columns. */
export function buildReviewNotesTable(
  fields: readonly (ContestedField & { readonly provenance?: Readonly<Record<string, string>> })[],
): Table {
  const provenance = [...new Set(fields.flatMap((field) => Object.keys(field.provenance ?? {})))];
  const recorded = fields.some((field) => field.record !== undefined);
  const width = Math.max(0, ...fields.map((field) => field.candidates.length));
  const candidates = Array.from({ length: width }, (_, index) => `Candidate ${index + 1}`);
  return {
    columns: [...provenance, ...(recorded ? ["Record"] : []), "Field", "Note", ...candidates],
    rows: fields.map((field) => ({
      ...field.provenance,
      ...(field.record !== undefined ? { Record: field.record + 1 } : {}),
      Field: fieldName(field.path),
      Note: NOTE,
      ...Object.fromEntries(field.candidates.map((value, index) => [candidates[index]!, candidateCell(value)])),
    })),
  };
}
