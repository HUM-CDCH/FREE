export type CellValue = string | number | boolean | null;

export interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
}

/** Escapes separators and numeric object keys so they cannot impersonate nested paths or indexes. */
const escapeSegment = (segment: string): string => {
  const escaped = segment.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
  return /^\d+$/.test(segment) ? `\\${escaped}` : escaped;
};

function flattenInto(
  value: unknown,
  path: readonly string[],
  row: Record<string, CellValue>,
): void {
  const column = path.length > 0 ? path.join(".") : "value";

  if (value === undefined) {
    if (path.length > 0) row[column] = null;
    return;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    row[column] = value;
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Field ${column} must hold a finite number.`);
    }
    row[column] = value;
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0 && path.length > 0) row[column] = null;
    value.forEach((item, index) => flattenInto(item, [...path, String(index)], row));
    return;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && path.length > 0) row[column] = null;
    for (const [key, child] of entries) {
      flattenInto(child, [...path, escapeSegment(key)], row);
    }
    return;
  }

  throw new TypeError(`Field ${column} holds an unsupported ${typeof value} value.`);
}

/** Flattens one record into escaped paths such as `authors.0.name`. */
export function flattenRecord(record: unknown): Readonly<Record<string, CellValue>> {
  const row: Record<string, CellValue> = Object.create(null);
  flattenInto(record, [], row);
  return row;
}

/**
 * Turns a visible Extraction Result into rows and columns.
 * One record becomes one row. Extraction Schema paths lead, then unexpected
 * fields follow in first-seen order.
 */
export function toTable(result: unknown, schemaColumns: readonly string[] = []): Table {
  const rows = (Array.isArray(result) ? result : [result]).map(flattenRecord);
  const columns: string[] = [];
  const seen = new Set<string>();

  for (const column of [...schemaColumns, ...rows.flatMap((row) => Object.keys(row))]) {
    if (seen.has(column)) continue;
    seen.add(column);
    columns.push(column);
  }

  return { columns, rows };
}
