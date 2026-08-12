import assert from 'node:assert/strict'
import { after, test } from 'node:test'

/**
 * The cascade is a PostgreSQL behaviour, so only PostgreSQL can prove it. This
 * check is deliberately outside the `src/*.test.ts` unit glob and never skips:
 * `pnpm --filter db test:postgres` fails loudly when it has no database, so a
 * green run always means the cascade actually ran.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('PostgreSQL cascades the complete Project Context graph', async () => {
    if (!databaseUrl)
      throw new Error(
        'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: docker compose -f packages/db/docker-compose.yml up -d && createdb free_test_cascade.',
      )
    const url = new URL(databaseUrl)
    if (!url.pathname.slice(1).startsWith('free_test_'))
      throw new Error('The PostgreSQL cascade check requires a free_test_* database.')
    process.env.DATABASE_URL = databaseUrl

    const [{ db }, { createProjectStore }] = await Promise.all([
      import('./prisma/db.js'),
      import('./project-store.js'),
    ])
    after(() => db.close())

    const project = await db.orm.public.ProjectContext.create({ name: 'Doomed' })
    const survivor = await db.orm.public.ProjectContext.create({ name: 'Survivor' })
    const document = await db.orm.public.SourceDocument.create({
      projectContextId: project.id,
      contentSha256: 'a'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'doomed.pdf',
    })
    const survivingDocument = await db.orm.public.SourceDocument.create({
      projectContextId: survivor.id,
      contentSha256: 'b'.repeat(64),
      mediaType: 'application/pdf',
      originalName: 'survivor.pdf',
    })
    const representation =
      await db.orm.public.SourceRepresentationRevision.create({
        sourceDocumentId: document.id,
        revisionNumber: 1,
        artifactReference: 'c'.repeat(64),
        artifactSha256: 'c'.repeat(64),
        contractVersion: 'parsed_document.v2',
        preprocessId: `sha256:${'d'.repeat(64)}`,
        parserName: 'test',
        parserVersion: '1',
      })
    await db.orm.public.SourceRepresentationRevision.create({
      sourceDocumentId: survivingDocument.id,
      revisionNumber: 1,
      artifactReference: 'c'.repeat(64),
      artifactSha256: 'c'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'d'.repeat(64)}`,
      parserName: 'test',
      parserVersion: '1',
    })
    const annotation = await db.orm.public.AnnotationSetRevision.create({
      sourceDocumentId: document.id,
      sourceRepresentationRevisionId: representation.id,
      revisionNumber: 1,
      snapshot: {},
    })
    const schema = await db.orm.public.ExtractionSchema.create({
      projectContextId: project.id,
      name: 'Schema',
    })
    const prompt = await db.orm.public.PromptRevision.create({
      extractionSchemaId: schema.id,
      revisionNumber: 1,
      text: 'Extract.',
    })
    const suggestion = await db.orm.public.SchemaSuggestion.create({
      extractionSchemaId: schema.id,
      promptRevisionId: prompt.id,
      annotationMode: 'hints',
      outcome: 'SUCCEEDED',
      modelAttribution: {},
      proposedTree: [],
    })
    await db.orm.public.SchemaSuggestionInput.create({
      schemaSuggestionId: suggestion.id,
      sourceRepresentationRevisionId: representation.id,
      annotationSetRevisionId: annotation.id,
    })
    const baseRevision = await db.orm.public.SchemaRevision.create({
      extractionSchemaId: schema.id,
      schemaSuggestionId: suggestion.id,
      revisionNumber: 1,
      origin: 'SUGGESTION',
      schemaTree: [],
    })
    const edit = await db.orm.public.ConversationalSchemaEdit.create({
      extractionSchemaId: schema.id,
      baseSchemaRevisionId: baseRevision.id,
      sourceRepresentationRevisionId: representation.id,
      annotationSetRevisionId: annotation.id,
      promptRevisionId: prompt.id,
      instruction: 'Add a field.',
      outcome: 'SUCCEEDED',
      modelAttribution: {},
      proposedTree: [],
    })
    const appliedRevision = await db.orm.public.SchemaRevision.create({
      extractionSchemaId: schema.id,
      conversationalSchemaEditId: edit.id,
      revisionNumber: 2,
      origin: 'MODEL_EDIT',
      schemaTree: [],
    })
    const extraction = await db.orm.public.Extraction.create({
      schemaRevisionId: appliedRevision.id,
      sourceRepresentationRevisionId: representation.id,
      outcome: 'SUCCEEDED',
      modelAttribution: {},
      resultPayload: {},
    })
    await db.orm.public.ReviewDecision.create({
      extractionId: extraction.id,
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: [],
    })

    const candidates = await createProjectStore(db).deleteProjectContext(project.id)

    assert.deepEqual(candidates, [
      {
        artifactReference: representation.artifactReference,
        artifactSha256: representation.artifactSha256,
      },
    ])
    assert.deepEqual(
      (await db.orm.public.ProjectContext.select('id').all()).map(({ id }) => id),
      [survivor.id],
    )
    assert.deepEqual(
      (await db.orm.public.SourceDocument.select('id').all()).map(({ id }) => id),
      [survivingDocument.id],
    )
    assert.equal(
      await createProjectStore(db).isPackageReferenced(
        representation.artifactReference,
      ),
      true,
    )
    for (const table of [
      db.orm.public.AnnotationSetRevision,
      db.orm.public.ExtractionSchema,
      db.orm.public.PromptRevision,
      db.orm.public.SchemaSuggestion,
      db.orm.public.SchemaSuggestionInput,
      db.orm.public.SchemaRevision,
      db.orm.public.ConversationalSchemaEdit,
      db.orm.public.Extraction,
      db.orm.public.ReviewDecision,
    ])
      assert.deepEqual(await table.all(), [])

    await createProjectStore(db).deleteProjectContext(survivor.id)
})
