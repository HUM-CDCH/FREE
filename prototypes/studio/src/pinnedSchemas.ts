import burialFindsSchema from "../schemas/FieldReports/Burial_Finds.json";
import collagenExtractionSchema from "../schemas/JournalArticles/collagen_extraction.json";
import type {
	ExtractionSchemaEnvelope,
	ExtractionStrategy,
} from "./api";

export type PinnedSchema = {
	readonly id: string;
	readonly domain: string;
	readonly name: string;
	readonly strategy: ExtractionStrategy;
	readonly schema: ExtractionSchemaEnvelope;
};

export const burialFindsPinnedSchema = {
	id: "FieldReports/Burial_Finds",
	domain: "FieldReports",
	name: "Burial_Finds",
	strategy: "catalog",
	schema: burialFindsSchema,
} as const satisfies PinnedSchema;

export const collagenExtractionPinnedSchema = {
	id: "JournalArticles/collagen_extraction",
	domain: "JournalArticles",
	name: "collagen_extraction",
	strategy: "article",
	schema: collagenExtractionSchema,
} as const satisfies PinnedSchema;

export const pinnedSchemas: readonly PinnedSchema[] = [
	burialFindsPinnedSchema,
	collagenExtractionPinnedSchema,
];

export const defaultPinnedSchema = burialFindsPinnedSchema;
