export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ExtractionSchemaEnvelope = {
	readonly name?: string;
	readonly description?: string;
	readonly record: Record<string, unknown>;
	readonly _schema_metadata: Record<string, unknown>;
};

export type SchemaPath = readonly string[];
export type SetSchemaChange = {
	readonly operation: "set";
	readonly path: SchemaPath;
	readonly value: JsonValue;
};
export type SchemaChange = SetSchemaChange;
export type SchemaIssueCode =
	| "invalid_schema"
	| "invalid_path"
	| "protected_name"
	| "missing_parent"
	| "field_exists";
export type SchemaIssue = {
	readonly code: SchemaIssueCode;
	readonly path: SchemaPath;
	readonly message: string;
};
export type ApplyResult =
	| { readonly status: "applied"; readonly schema: ExtractionSchemaEnvelope }
	| { readonly status: "stale" }
	| { readonly status: "invalid"; readonly issues: readonly SchemaIssue[] };
export type SchemaSuggestion = {
	readonly id: string;
	readonly documentEpoch: number;
	readonly baseRevision: number;
	readonly summary: string;
	readonly changes: readonly SchemaChange[];
};
export type SchemaFreshness = {
	readonly documentEpoch: number;
	readonly revision: number;
};

const PROTECTED_NAMES = new Set([
	"_evidence",
	"_meta",
	"_schema_metadata",
	"__proto__",
	"constructor",
	"prototype",
]);
const EVIDENCE = Object.freeze({
	snippets: [] as string[],
	inferred: false,
	source_type: "",
	page: null,
	table_index: null,
	row_index: null,
	col_index: null,
	row_header_text: "",
	column_header_text: "",
});

export function validateExtractionSchema(value: unknown): {
	readonly valid: boolean;
	readonly issues: readonly SchemaIssue[];
} {
	const valid =
		isRecord(value) &&
		isRecord(value.record) &&
		isRecord(value._schema_metadata) &&
		(value.name === undefined || typeof value.name === "string") &&
		(value.description === undefined ||
			typeof value.description === "string") &&
		Object.keys(value).every((key) =>
			[
				"name",
				"description",
				"record",
				"_evidence",
				"_schema_metadata",
			].includes(key),
		) &&
		(value._evidence === undefined ||
			(isRecord(value._evidence) &&
				Object.keys(value._evidence).length === 0)) &&
		validateRecord(value.record) &&
		validateSchemaMetadata(value.record, value._schema_metadata);
	return valid
		? { valid: true, issues: [] }
		: {
				valid: false,
				issues: [
					issue("invalid_schema", [], "The Extraction Schema is malformed."),
				],
			};
}

export function applySchemaSuggestion(
	schema: ExtractionSchemaEnvelope,
	freshness: SchemaFreshness,
	suggestion: SchemaSuggestion,
): ApplyResult {
	if (
		freshness.documentEpoch !== suggestion.documentEpoch ||
		freshness.revision !== suggestion.baseRevision
	) {
		return { status: "stale" };
	}
	return applySchemaChanges(schema, suggestion.changes);
}

export function applySchemaChanges(
	schema: ExtractionSchemaEnvelope,
	changes: readonly SchemaChange[],
): ApplyResult {
	let working: ExtractionSchemaEnvelope = structuredClone(schema);
	for (const change of changes) {
		const result = applySet(working, change);
		if (result.status === "invalid") return result;
		working = result.schema;
	}
	const validation = validateExtractionSchema(working);
	return validation.valid
		? { status: "applied", schema: working }
		: { status: "invalid", issues: validation.issues };
}

type SetResult = Exclude<ApplyResult, { readonly status: "stale" }>;

function applySet(
	schema: ExtractionSchemaEnvelope,
	change: SetSchemaChange,
): SetResult {
	if (change.path.length === 0) {
		const validation = validateExtractionSchema(change.value);
		return validation.valid
			? {
					status: "applied",
					schema: structuredClone(change.value) as ExtractionSchemaEnvelope,
				}
			: { status: "invalid", issues: validation.issues };
	}
	for (const segment of change.path) {
		if (!segment.trim())
			return invalid(
				"invalid_path",
				change.path,
				"Schema paths cannot contain empty names.",
			);
		if (PROTECTED_NAMES.has(segment))
			return invalid(
				"protected_name",
				change.path,
				`Field name ${segment} is protected.`,
			);
	}

	let parent: Record<string, unknown> = schema.record;
	for (const segment of change.path.slice(0, -1)) {
		const child = own(parent, segment);
		const traversed = Array.isArray(child) ? child[0] : child;
		if (!isRecord(traversed))
			return invalid(
				"missing_parent",
				change.path,
				"The complete parent path must exist.",
			);
		parent = traversed;
	}

	const suppliedName = change.path.at(-1) as string;
	const exists = Object.hasOwn(parent, suppliedName);
	const name = exists ? suppliedName : normalizeFieldName(suppliedName);
	if (!name || PROTECTED_NAMES.has(name))
		return invalid(
			"protected_name",
			change.path,
			`Field name ${suppliedName} is protected.`,
		);
	if (!exists && Object.hasOwn(parent, name))
		return invalid(
			"field_exists",
			change.path,
			`Field ${name} already exists.`,
		);

	parent[name] = structuredClone(change.value);
	if (!exists) {
		const localEvidence = isRecord(parent._evidence) ? parent._evidence : {};
		parent._evidence = localEvidence;
		localEvidence[name] = structuredClone(EVIDENCE);
	}
	return { status: "applied", schema };
}

function normalizeFieldName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, "_");
}
function own(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}
function invalid(
	code: SchemaIssueCode,
	path: SchemaPath,
	message: string,
): SetResult {
	return { status: "invalid", issues: [issue(code, path, message)] };
}
function issue(
	code: SchemaIssueCode,
	path: SchemaPath,
	message: string,
): SchemaIssue {
	return { code, path, message };
}
function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isRecord(value)) return false;
	return Object.entries(value).every(
		([key, child]) =>
			!["__proto__", "constructor", "prototype"].includes(key) &&
			isJsonValue(child),
	);
}

function validateRecord(record: Record<string, unknown>): boolean {
	if (
		Object.keys(record).some((key) =>
			["__proto__", "constructor", "prototype", "_schema_metadata"].includes(
				key,
			),
		)
	)
		return false;
	if (record._meta !== undefined && !isRecord(record._meta)) return false;
	if (isRecord(record._meta) && !isJsonValue(record._meta)) return false;

	const fields = Object.entries(record).filter(([key]) => !key.startsWith("_"));
	if (!fields.every(([, field]) => validateField(field))) return false;
	if (record._evidence === undefined) return true;
	if (!isRecord(record._evidence)) return false;
	return Object.entries(record._evidence).every(
		([key, evidence]) =>
			Object.hasOwn(record, key) &&
			!isContainerField(record[key]) &&
			validateEvidence(evidence),
	);
}

function validateField(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value))
		return (
			value.length === 0 ||
			(value.length === 1 && isRecord(value[0]) && validateRecord(value[0]))
		);
	return isRecord(value) && validateRecord(value);
}

function isContainerField(value: unknown): boolean {
	return isRecord(value) || (Array.isArray(value) && value.length > 0);
}

function validateEvidence(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const expected = Object.keys(EVIDENCE);
	if (
		Object.keys(value).length !== expected.length ||
		!expected.every((key) => Object.hasOwn(value, key))
	)
		return false;
	return (
		Array.isArray(value.snippets) &&
		value.snippets.every((item) => typeof item === "string") &&
		typeof value.inferred === "boolean" &&
		typeof value.source_type === "string" &&
		(value.page === null || Number.isFinite(value.page)) &&
		(value.table_index === null || Number.isFinite(value.table_index)) &&
		(value.row_index === null || Number.isFinite(value.row_index)) &&
		(value.col_index === null || Number.isFinite(value.col_index)) &&
		typeof value.row_header_text === "string" &&
		typeof value.column_header_text === "string"
	);
}

function validateSchemaMetadata(
	record: Record<string, unknown>,
	metadata: Record<string, unknown>,
): boolean {
	return Object.entries(metadata).every(
		([path, value]) =>
			isRecord(value) &&
			isJsonValue(value) &&
			(path === "entry_key" || resolvesMetadataPath(record, path)),
	);
}

function resolvesMetadataPath(
	record: Record<string, unknown>,
	path: string,
): boolean {
	const segments = path.split(".");
	if (segments.shift() !== "record" || segments.length === 0) return false;
	let current: unknown = record;
	for (const [index, rawSegment] of segments.entries()) {
		const repeated = rawSegment.endsWith("[]");
		const key = repeated ? rawSegment.slice(0, -2) : rawSegment;
		if (!key || !isRecord(current) || !Object.hasOwn(current, key))
			return false;
		current = current[key];
		if (repeated) {
			if (
				!Array.isArray(current) ||
				current.length !== 1 ||
				!isRecord(current[0])
			)
				return false;
			current = current[0];
		} else if (Array.isArray(current) && index < segments.length - 1) {
			return false;
		}
	}
	return true;
}
