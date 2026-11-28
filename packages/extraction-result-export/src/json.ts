import { schemaPathNames, type SchemaNode } from "extraction/schema";
import { originPages } from "extraction/value-disagreement";
import { createFieldRegistry, decisionWords, durableRecords, exportedValue, type DurableExportValue, type FieldRegistry } from "./durable.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A saved value in the shape its field declares, for the JSON export: a group stays an object with every declared part
 * (null when empty, in the template's order), a list stays a list of its items, and nothing is flattened to text. A value
 * that does not fit its field (a lone item where a list is declared, a word where a group is) is kept, never dropped:
 * a lone item becomes a one-item list; anything else is written as it was saved. Parts a value holds beyond its field's
 * declaration follow the declared ones.
 */
export function structuredValue(node: SchemaNode, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (node.type === "object") {
    if (!isObject(value)) return value;
    const declared = new Set(node.children.map((child) => child.name));
    return {
      ...Object.fromEntries(node.children.map((child) => [child.name, structuredValue(child, value[child.name])])),
      ...Object.fromEntries(Object.entries(value).filter(([name]) => !declared.has(name))),
    };
  }
  if (node.type === "array") {
    const items = Array.isArray(value) ? value : [value];
    const children = node.children;
    if (!children) return items.map((item) => item ?? null);
    const item: SchemaNode = { id: node.id, name: node.name, type: "object", children };
    return items.map((each) => structuredValue(item, each));
  }
  return value;
}

/** One reading at a disagreeing place, with where in the source document it was read. */
export interface JsonDisagreementAlternative {
  readonly value: unknown;
  readonly readIn: string | null;
}

/** One Value Disagreement on a field or nested object part, paired with its review status and distinct readings. */
export interface JsonDisagreement {
  /** 0-based index into `records`, or `null` for a document-level (`document`) field. */
  readonly record: number | null;
  readonly field: string;
  /** Dotted display label for the disagreeing place. */
  readonly part: string;
  /** JSON property names relative to `field`, or `[]` for the whole field value. */
  readonly path: readonly string[];
  readonly review: string;
  readonly alternatives: readonly JsonDisagreementAlternative[];
}

/** One Source Document's results as nested JSON: the fields read once for the whole document, and the records. */
export interface JsonResults {
  /** Fields read from the document as a whole (its catalogue name, its filename), present only when the template has them. */
  readonly document?: Record<string, unknown>;
  /** One object per record, in the order the run found them, every declared field present (null when it has no value). */
  readonly records: Record<string, unknown>[];
  /** Value Disagreements on the exported fields (unresolved and reviewed), omitted when there are none. */
  readonly disagreements?: JsonDisagreement[];
}

/**
 * The researcher's reviewed values with the template's hierarchy kept: edits applied, rejected or missing values null.
 * Field names are the export's column names, so a field produced under two types keeps both (`year (string)`).
 * Fields with a Value Disagreement keep `null` at undecided places and list their review status and readings in `disagreements`.
 */
export function durableJsonResults(values: readonly DurableExportValue[], registry: FieldRegistry = createFieldRegistry(values)): JsonResults {
  const nodes = registry.schemaNodes;
  const own = nodes.filter((node) => !node.valueSource);
  const shared = nodes.filter((node) => node.valueSource);
  const byRecord = new Map<string, Map<string, unknown>>();
  const documentFields = new Map<string, unknown>();
  for (const value of values) {
    const column = registry.column(value.node).name;
    const exported = exportedValue(value);
    const shaped = structuredValue(value.node, exported);
    if (value.node.valueSource) { documentFields.set(column, shaped); continue; }
    const fields = byRecord.get(value.recordId) ?? new Map<string, unknown>();
    fields.set(column, shaped);
    byRecord.set(value.recordId, fields);
  }
  // The records' order is the spreadsheet's: the order the run found them.
  const order = durableRecords(values, registry).map((record) => record.recordId).filter((id) => byRecord.has(id));
  const records = order.map((id) => Object.fromEntries(own.map((node) => [node.name, byRecord.get(id)!.get(node.name) ?? null])));
  const recordIndex = new Map(order.map((id, index) => [id, index]));
  const fieldOrder = new Map(nodes.map((node, index) => [node.name, index]));
  const disagreements: JsonDisagreement[] = values
    .flatMap((value) => {
      if (!value.disagreement?.length) return [];
      const field = registry.column(value.node).name;
      const record = value.node.valueSource ? null : recordIndex.get(value.recordId) ?? null;
      const review = decisionWords(value);
      return value.disagreement.map((entry) => {
        const path = schemaPathNames(value.node, entry.path);
        if (path === undefined) throw new Error(`Cannot export a Value Disagreement with an invalid path in field "${field}".`);
        return {
          record,
          field,
          part: path.join("."),
          path,
          review,
          alternatives: entry.alternatives.map((alternative) => ({
            value: alternative.value,
            readIn: originPages(alternative.segments),
          })),
        };
      });
    })
    .sort((left, right) =>
      (left.record ?? -1) - (right.record ?? -1) ||
      (fieldOrder.get(left.field) ?? Number.MAX_SAFE_INTEGER) - (fieldOrder.get(right.field) ?? Number.MAX_SAFE_INTEGER));
  return {
    ...(shared.length > 0 ? { document: Object.fromEntries(shared.map((node) => [node.name, documentFields.get(node.name) ?? null])) } : {}),
    records,
    ...(disagreements.length > 0 ? { disagreements } : {}),
  };
}
