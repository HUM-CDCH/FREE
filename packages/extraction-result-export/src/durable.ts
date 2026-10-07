import type { SchemaNode } from "extraction/schema";
import { buildExportTable, type CellValue, type ExportChoices, type Table } from "./table.js";

/**
 * One saved value of a durable Extraction, as its fixed result page projects it: one top-level schema field of one
 * record, with the node that produced it and the researcher's compatible decision on it. Only the fields the export
 * reads are declared here; a page value carries more (Evidence, lineage, identities), which the export leaves alone.
 */
export interface DurableExportValue {
  readonly id: string;
  readonly recordId: string;
  readonly path: readonly (string | number)[];
  readonly node: SchemaNode;
  readonly schemaRevisionId: string;
  readonly modelValue: unknown;
  readonly processing: "saved" | "absent" | "unprocessed" | "failed";
  readonly grounding: "grounded" | "ungrounded" | "provisional";
  readonly links?: readonly { readonly evidenceAnchorId: string }[];
  readonly correction?: {
    readonly decision: { readonly action: "APPROVED" | "EDITED" | "REJECTED" | "PENDING"; readonly value?: unknown };
  } | null;
  /** A saved correction that no longer fits this value's producing type: shown, never applied. */
  readonly historicalCorrection?: unknown;
}

export const DOCUMENT_RECORD = "Document";
export const EXTRACTION_SHEET = "Extraction";
export const EVIDENCE_SHEET = "Evidence";

/** The value a researcher sees and exports: the edit when edited, nothing when rejected or never saved. */
export function exportedValue(value: DurableExportValue): unknown {
  if (value.processing !== "saved") return undefined;
  const action = value.correction?.decision.action;
  if (action === "EDITED") return value.correction!.decision.value;
  if (action === "REJECTED") return null;
  return value.modelValue;
}

/** The shape of a field's producing type, without ids or descriptions: two revisions that declare the same shape share a column. */
function typeShape(node: SchemaNode): unknown {
  return [node.type, node.itemType ?? null, node.children?.map((child) => [child.name, typeShape(child)]) ?? null];
}

/** Words for a producing type, used to tell apart columns of one name produced under different types. */
export function typeWords(node: SchemaNode): string {
  if (node.type === "object") return "object";
  if (node.type === "array") return node.children ? "list of objects" : `list of ${node.itemType}`;
  return node.type;
}

/**
 * The fields of one export: matching declarations first, then other producing nodes in first-appearance order,
 * keyed by name and type shape.
 * A name produced under two different types keeps the first as the plain column and names the others by their type
 * (`year (string)`), so neither is dropped or silently merged. One registry may span a batch's members.
 */
export interface FieldRegistry {
  /** The column node for a producing node: the node itself, or a copy renamed to tell its type apart. */
  column(node: SchemaNode): SchemaNode;
  /** The nodes in column order. */
  readonly schemaNodes: readonly SchemaNode[];
  /** Names produced under more than one type, with the column each type got. */
  readonly ambiguous: readonly { readonly name: string; readonly columns: readonly string[] }[];
}

const fieldKey = (node: SchemaNode): string => JSON.stringify([node.name, typeShape(node)]);

export function createFieldRegistry(values: readonly DurableExportValue[] = [], declared: readonly SchemaNode[] = []): FieldRegistry {
  const byShape = new Map<string, SchemaNode>();
  const byName = new Map<string, SchemaNode[]>();
  const nodes: SchemaNode[] = [];
  const reservedNames = new Set(values.map(value => value.node.name));
  const registry: FieldRegistry = {
    column(node) {
      const key = fieldKey(node);
      const known = byShape.get(key);
      if (known) return known;
      const siblings = byName.get(node.name) ?? [];
      let column: SchemaNode = node;
      if (siblings.length > 0 || nodes.some(each => each.name === node.name)) {
        let name = `${node.name} (${typeWords(node)})`;
        for (let ordinal = 2; reservedNames.has(name) || nodes.some((each) => each.name === name); ordinal += 1)
          name = `${node.name} (${typeWords(node)}, ${ordinal})`;
        column = { ...node, name } as SchemaNode;
      }
      byShape.set(key, column);
      byName.set(node.name, [...siblings, column]);
      nodes.push(column);
      return column;
    },
    get schemaNodes() { return nodes; },
    get ambiguous() {
      return [...byName].filter(([, columns]) => columns.length > 1)
        .map(([name, columns]) => ({ name, columns: columns.map((column) => column.name) }));
    },
  };
  // Declarations only order matching saved fields. An adopted schema must never rename or retype older values.
  const producing = new Map(values.map(value => [fieldKey(value.node), value.node]));
  for (const node of declared) {
    const own = producing.get(fieldKey(node));
    if (own) registry.column(own);
  }
  for (const value of values) registry.column(value.node);
  return registry;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scalarCell = (value: unknown): CellValue =>
  value === undefined || value === null || typeof value === "string" || typeof value === "boolean" ? value ?? null
    : typeof value === "number" && Number.isFinite(value) ? value
      : typeof value === "number" ? String(value) : JSON.stringify(value);

/** Fits a saved value to its producing node so the schema-led projection never drops it: a composite value at a
 *  scalar node becomes its JSON text; a lone item at a list node becomes a one-item list. */
export function conform(node: SchemaNode, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (node.type === "object")
    return isObject(value) ? Object.fromEntries(node.children.map((child) => [child.name, conform(child, value[child.name])])) : { [node.children[0]?.name ?? ""]: scalarCell(value) };
  if (node.type === "array") {
    const items = Array.isArray(value) ? value : [value];
    if (node.children) {
      const children = node.children;
      return items.map((item) => conform({ id: node.id, name: node.name, type: "object", children }, item));
    }
    return items.map(scalarCell);
  }
  return scalarCell(value);
}

/** One record of a durable result: its fields by column name, and where it stands among the records. */
export interface DurableRecord {
  readonly recordId: string;
  /** The record's ordinal among those the run found (0-based), or null for the document itself. */
  readonly ordinal: number | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * The records a fixed result page holds, one object per record with its fields under their column names (each
 * schema field once, document-level fields repeated on every record), in the order the run found the records.
 */
export function durableRecords(values: readonly DurableExportValue[], registry: FieldRegistry = createFieldRegistry()): DurableRecord[] {
  const shared: Record<string, unknown> = Object.create(null);
  const records = new Map<string, { ordinal: number | null; fields: Record<string, unknown> }>();
  for (const value of values) {
    const column = registry.column(value.node).name;
    const exported = exportedValue(value);
    const cell = exported === undefined ? undefined : conform(value.node, exported);
    if (value.node.valueSource) { if (cell !== undefined) shared[column] = cell; continue; }
    let record = records.get(value.recordId);
    if (!record) {
      record = { ordinal: typeof value.path[1] === "number" ? value.path[1] : null, fields: Object.create(null) };
      records.set(value.recordId, record);
    }
    if (cell !== undefined) record.fields[column] = cell;
  }
  if (records.size === 0)
    return Object.keys(shared).length > 0 ? [{ recordId: DOCUMENT_RECORD, ordinal: null, fields: shared }] : [];
  return [...records].map(([recordId, record]) => ({ recordId, ordinal: record.ordinal, fields: { ...shared, ...record.fields } }))
    .sort((left, right) => (left.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.ordinal ?? Number.MAX_SAFE_INTEGER));
}

/** The fields a fixed result page declares, for the Rows represent choices before any table is built. */
export function durableSchemaNodes(values: readonly DurableExportValue[], declared: readonly SchemaNode[] = []): readonly SchemaNode[] {
  return createFieldRegistry(values, declared).schemaNodes;
}

/** The ordinary research table of one fixed result page: schema fields as columns, one row per record (or per
 *  selected repeated object), the researcher's edits applied and rejected values left empty. */
export function buildDurableExportTable(values: readonly DurableExportValue[], choices: ExportChoices, declared: readonly SchemaNode[] = []): Table {
  const registry = createFieldRegistry(values, declared);
  const records = durableRecords(values, registry);
  return buildExportTable(registry.schemaNodes, records.map((record) => record.fields), choices);
}

const decisionWords = (value: DurableExportValue): string => {
  if (value.processing !== "saved") return value.processing === "absent" ? "No value" : value.processing === "failed" ? "Failed" : "Not read";
  switch (value.correction?.decision.action) {
    case "APPROVED": return "Approved";
    case "EDITED": return "Edited";
    case "REJECTED": return "Rejected";
    default: return "To check";
  }
};

const evidenceWords = (value: DurableExportValue): string =>
  value.links?.length ? "Evidence linked" : value.grounding === "provisional" ? "Evidence still being checked" : "No Evidence linked";

/** The compact Evidence sheet: one row per saved field with its extracted value, decision, reviewed value, Evidence
 *  status and anchors, so a workbook keeps what the Results sheet's one cell per field cannot say. */
export function buildDurableEvidenceTable(values: readonly DurableExportValue[]): Table {
  const registry = createFieldRegistry(values);
  const ordinals = new Map(durableRecords(values, registry).map((record) => [record.recordId, record.ordinal]));
  return {
    columns: ["Record", "Field", "Extracted value", "Decision", "Reviewed value", "Evidence", "Evidence anchors", "Schema revision", "Note"],
    rows: values.map((value) => {
      const ordinal = value.node.valueSource ? null : ordinals.get(value.recordId) ?? null;
      const action = value.correction?.decision.action;
      return {
        Record: ordinal === null ? DOCUMENT_RECORD : ordinal + 1,
        Field: registry.column(value.node).name,
        "Extracted value": value.processing === "saved" ? scalarCell(value.modelValue) : null,
        Decision: decisionWords(value),
        "Reviewed value": action === "EDITED" ? scalarCell(value.correction!.decision.value) : null,
        Evidence: evidenceWords(value),
        "Evidence anchors": value.links?.length ? value.links.map((link) => link.evidenceAnchorId).join(", ") : null,
        "Schema revision": value.schemaRevisionId,
        Note: value.historicalCorrection ? "An earlier correction does not fit this value; it stays saved and is not applied." : null,
      };
    }),
  };
}

/** The Extraction sheet: one Item/Value row per identity entry, in the given order. */
export function buildIdentityTable(identity: readonly (readonly [string, CellValue])[]): Table {
  return { columns: ["Item", "Value"], rows: identity.map(([item, value]) => ({ Item: item, Value: value })) };
}
