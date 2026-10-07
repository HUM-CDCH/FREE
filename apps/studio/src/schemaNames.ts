import { extractionSchemaNameSchema } from '../shared/schemaRevision.contract'

export const UNTITLED_SCHEMA_NAME = 'Untitled schema'

/** The name a generated or imported schema gets: the Source Document's file name without its extension (§5). */
export function defaultSchemaName(sourceDocumentName: string): string {
  const base = sourceDocumentName.replace(/\.[^./\\]+$/, '').trim()
  return extractionSchemaNameSchema.safeParse(base).success ? base : UNTITLED_SCHEMA_NAME
}
