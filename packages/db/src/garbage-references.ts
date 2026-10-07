import { db, type Database } from './prisma/db.js'

/** The IDs a sweep found on workflow histories, by the kind of row each names. */
export type ScopeIds = Readonly<{
  projectContextIds: readonly string[]
  sourceDocumentIds: readonly string[]
  sourceRepresentationRevisionIds: readonly string[]
  extractionSchemaIds: readonly string[]
  batchSchemaSuggestionIds: readonly string[]
}>

/** Which of the asked-for rows still exist: an ID absent from the snapshot no longer exists. */
export type ScopeSnapshot = Readonly<{
  projectContexts: ReadonlySet<string>
  sourceDocuments: ReadonlySet<string>
  sourceRepresentationRevisions: ReadonlySet<string>
  extractionSchemas: ReadonlySet<string>
  /** settled: the current attempt has an outcome. */
  suggestions: ReadonlyMap<string, Readonly<{ attempt: number; settled: boolean }>>
}>

/** The domain references garbage collection decides on. Every read rejects when the database does; none resolves empty. */
export type GarbageReferences = Readonly<{
  scopes(ids: ScopeIds): Promise<ScopeSnapshot>
  /** Every surviving Source Representation Revision's preprocessId, and the source every durable Extraction head pins
   *  (a tombstoned head included, until its graph is collected after native-call quiescence). */
  referencedPreprocessIds(): Promise<ReadonlySet<string>>
  /** The given packages that a surviving Source Representation Revision pins. */
  referencedPackages(artifactReferences: readonly string[]): Promise<ReadonlySet<string>>
  packageIsReferenced(artifactReference: string): Promise<boolean>
}>

// Mirrors CANONICAL_UUID_PATTERN in packages/studio-configuration.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** Only canonical lowercase UUIDs can name a row; anything else (a test's placeholder, a corrupt attribute) is absent
 *  without a query, so one bad attribute can never fail — and so stall — every sweep. */
const ids = (values: readonly string[]) => [...new Set(values.filter((value) => UUID.test(value)))]

export const EMPTY_SCOPE_IDS: ScopeIds = {
  projectContextIds: [],
  sourceDocumentIds: [],
  sourceRepresentationRevisionIds: [],
  extractionSchemaIds: [],
  batchSchemaSuggestionIds: [],
}

/** Whether any surviving Source Representation Revision pins this package. */
export async function packageIsReferenced(database: Database, artifactReference: string): Promise<boolean> {
  return Boolean(await database.orm.public.SourceRepresentationRevision.select('id').first({ artifactReference })) ||
    Boolean(await database.orm.extraction_runtime.ArtifactReference.select('id').first({reference:artifactReference}))
}

export function createGarbageReferences(database: Database = db): GarbageReferences {
  const orm = database.orm.public
  return {
    async scopes(input) {
      const wanted = {
        projects: ids(input.projectContextIds),
        documents: ids(input.sourceDocumentIds),
        revisions: ids(input.sourceRepresentationRevisionIds),
        schemas: ids(input.extractionSchemaIds),
        suggestions: ids(input.batchSchemaSuggestionIds),
      }
      const [projects, documents, revisions, schemas, suggestions] = await Promise.all([
        wanted.projects.length
          ? orm.ProjectContext.where((row) => row.id.in(wanted.projects)).select('id').all()
          : [],
        wanted.documents.length
          ? orm.SourceDocument.where((row) => row.id.in(wanted.documents)).select('id').all()
          : [],
        wanted.revisions.length
          ? orm.SourceRepresentationRevision.where((row) => row.id.in(wanted.revisions)).select('id').all()
          : [],
        wanted.schemas.length
          ? orm.ExtractionSchema.where((row) => row.id.in(wanted.schemas)).select('id').all()
          : [],
        wanted.suggestions.length
          ? orm.BatchSchemaSuggestion.where((row) => row.id.in(wanted.suggestions))
              .select('id', 'attempt', 'outcome')
              .all()
          : [],
      ])
      const idSet = (rows: readonly { id: string }[]) => new Set(rows.map((row) => row.id))
      return {
        projectContexts: idSet(projects),
        sourceDocuments: idSet(documents),
        sourceRepresentationRevisions: idSet(revisions),
        extractionSchemas: idSet(schemas),
        suggestions: new Map(
          suggestions.map((row) => [row.id, { attempt: row.attempt, settled: row.outcome !== null }]),
        ),
      }
    },
    async referencedPreprocessIds() {
      const rows = await orm.SourceRepresentationRevision.select('preprocessId').all()
      const heads=await database.orm.extraction_runtime.Head.select('sourcePin').all()
      return new Set([...rows.map(row=>row.preprocessId),...heads.flatMap(head=> {
        const pin=head.sourcePin as {runId?:string;generation?:string}
        return pin.runId&&pin.generation?[`kei-exp:${pin.runId}:${pin.generation}`]:[]
      })])
    },
    async referencedPackages(references) {
      const wanted = [...new Set(references)]
      if (wanted.length === 0) return new Set()
      const rows = await orm.SourceRepresentationRevision.where((row) => row.artifactReference.in(wanted))
        .select('artifactReference')
        .all()
      const retained=await database.orm.extraction_runtime.ArtifactReference.where(row=>row.reference.in(wanted)).select('reference').all()
      return new Set([...rows.map(row=>row.artifactReference),...retained.map(row=>row.reference)])
    },
    packageIsReferenced(artifactReference) {
      return packageIsReferenced(database, artifactReference)
    },
  }
}
