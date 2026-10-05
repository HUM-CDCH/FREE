import { expect, test, type Page } from '@playwright/test'
import type { BatchExtractionSnapshot, ExtractionModule } from 'extraction'
import type { ExtractionMethodIntent } from 'extraction/extraction-method'
import {
  emptyProjectContextActivitySummary,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { createGetExtractionSchemas } from '../api/extraction_schemas.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { createSchemaRevisionHandlers } from '../api/schema_revisions.js'
import { gotoAuthenticated } from './auth.js'
import { emulateBrowserZoom200 } from './accessibility.js'

const id = {
  project: '74000000-0000-4000-8000-000000000001',
  beretning: '74000000-0000-4000-8001-000000000001',
  fundliste: '74000000-0000-4000-8001-000000000002',
  beretningRevision: '74000000-0000-4000-8002-000000000001',
  fundlisteRevision: '74000000-0000-4000-8002-000000000002',
  schema: '74000000-0000-4000-8003-000000000001',
  revision: '74000000-0000-4000-8004-000000000001',
  beretningExtraction: '74000000-0000-4000-8006-000000000001',
  fundlisteExtraction: '74000000-0000-4000-8006-000000000002',
} as const

const documentName = {
  [id.beretning]: 'Beretning_Ellekilde_8_13.pdf',
  [id.fundliste]: 'Fundliste_Ellekilde.pdf',
} as const

/** The pinned Schema Revision every member of the batch is extracted through. */
const schemaTree = {
  recordDescription: 'One place record.',
  schemaNodes: [
    { id: 'place', name: 'place', type: 'string' },
    { id: 'year', name: 'year', type: 'number' },
  ],
}

function readySuggestionDto(
  draft = schemaTree,
  draftVersion = 0,
) {
  return {
    batchSchemaSuggestionId: '74000000-0000-4000-8008-000000000001',
    projectContextId: id.project,
    selectionKey: 'a'.repeat(64),
    attempt: 1,
    executionStatus: 'COMPLETED',
    phase: 'READY',
    sourceKind: 'DOCUMENTS',
    purpose: null,
    columnFieldMapping: null,
    projectSpreadsheetVersionId: null,
    proposal: schemaTree,
    sourceCoverage: null,
    draft,
    draftVersion,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    sources: [
      [id.beretning, id.beretningRevision],
      [id.fundliste, id.fundlisteRevision],
    ].map(([sourceDocumentId, sourceRepresentationRevisionId]) => ({
      sourceDocumentId,
      sourceRepresentationRevisionId,
    })),
  }
}

const at = (minute: number) => new Date(`2026-08-19T10:${String(minute).padStart(2, '0')}:00.000Z`)

type StudioStore = Pick<
  ResearcherProjectStore,
  | 'listProjectContexts'
  | 'getProjectContextWithDocuments'
  | 'listExtractionSchemas'
  | 'listSchemaRevisions'
  | 'getSchemaRevision'
  | 'initializeSchemaRevision'
  | 'appendSchemaRevision'
>
function batchDto(batch: BatchExtractionSnapshot) {
  return {
    batchExtractionId: batch.batchExtractionId,
    projectContextId: batch.projectContextId,
    schemaRevisionId: batch.schemaRevisionId,
    extractionSchemaId: batch.extractionSchemaId,
    extractionSchemaName: batch.extractionSchemaName,
    schemaRevisionNumber: batch.schemaRevisionNumber,
    strategy: batch.strategy,
    executionStatus: batch.executionStatus,
    createdAt: batch.createdAt.toISOString(),
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId:
        member.sourceRepresentationRevisionId,
      executionStatus: member.executionStatus,
      extractionId: member.extractionId,
      reviewable: member.reviewable,
      currentReview: member.currentReview && { ...member.currentReview, createdAt: member.currentReview.createdAt.toISOString() },
    })),
  }
}

function createBatchFixtureHandler(
  extractions: ExtractionModule,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST') {
      const input = (await request.json()) as {
        projectContextId: string
        schemaRevisionId: string
        strategy: 'ARTICLE'
        sourceDocumentIds: string[]
        force?: boolean
        method: ExtractionMethodIntent
      }
      const { force, ...selection } = input
      const opened = await extractions.scheduleBatch({
        ...selection,
        repetition: force
          ? 'create-new'
          : 'reuse-equal-selection',
      })
      return Response.json(
        {
          batchExtraction: batchDto(opened.batch),
          disposition: opened.disposition,
        },
        { status: 202 },
      )
    }
    if (url.pathname === '/api/batch-extractions') {
      const batches = await extractions.listBatches({
        projectContextId: url.searchParams.get('projectContextId')!,
        limit: Number(url.searchParams.get('limit') ?? 50),
      })
      return Response.json({
        batchExtractions: batches.map(batchDto),
      })
    }
    const projectContextId = url.searchParams.get('projectContextId')!
    const item = /^\/api\/batch-extractions\/([^/]+)$/.exec(
      url.pathname,
    )
    if (!item) return Response.json({}, { status: 404 })
    return Response.json({
      batchExtraction: batchDto(
        await extractions.readBatch({
          projectContextId,
          batchExtractionId: item[1]!,
        }),
      ),
    })
  }
}

/**
 * The persisted state Studio would serve from PostgreSQL, plus the one moving
 * part a Batch Extraction has: the durable worker. The batch opens QUEUED and a
 * later read finds it finished, exactly as the panel's polling would observe it.
 */
function batchFixture(nested = false): {
  store: StudioStore
  extractions: ExtractionModule
} {
  let batch: BatchExtractionSnapshot | null = null
  const fixtureSchema = nested ? {
    ...schemaTree,
    schemaNodes: [...schemaTree.schemaNodes, {
      id: 'finds', name: 'finds', type: 'array',
      children: [{ id: 'material', name: 'material', type: 'string' }],
    }],
  } : schemaTree
  let readsWhileQueued = 0

  const member = (
    sourceDocumentId: string,
    sourceRepresentationRevisionId: string,
    extractionId: string,
    finished: boolean,
  ) => ({
    sourceDocumentId,
    sourceRepresentationRevisionId,
    executionStatus: finished ? ('COMPLETED' as const) : ('QUEUED' as const),
    extractionId,
    reviewable: finished,
    currentReview: null,
  })

  const snapshot = (finished: boolean): BatchExtractionSnapshot => ({
    batchExtractionId: batch!.batchExtractionId,
    projectContextId: id.project,
    schemaRevisionId: id.revision,
    extractionSchemaId: id.schema,
    extractionSchemaName: 'Places',
    schemaRevisionNumber: 4,
    strategy: 'ARTICLE',
    executionStatus: finished ? 'COMPLETED' : 'QUEUED',
    createdAt: at(42),
    members: [
      member(id.beretning, id.beretningRevision, id.beretningExtraction, finished),
      member(id.fundliste, id.fundlisteRevision, id.fundlisteExtraction, finished),
    ],
  })

  const project = {
    projectContextId: id.project,
    name: 'Ellekilde, TAK 1355',
    createdAt: at(0),
  }
  const unsupported = () => {
    throw new Error('This specification does not issue that operation.')
  }
  const store: StudioStore = {
    async listProjectContexts() {
      return [
        {
          ...project,
          sourceDocumentCount: 2,
          summary: emptyProjectContextActivitySummary(project.createdAt),
        },
      ]
    },
    async getProjectContextWithDocuments(projectContextId) {
      if (projectContextId !== id.project) return null
      return {
        projectContext: project,
        sourceDocuments: [
          { sourceDocumentId: id.beretning, name: documentName[id.beretning], createdAt: at(1) },
          { sourceDocumentId: id.fundliste, name: documentName[id.fundliste], createdAt: at(2) },
        ],
      }
    },
    async listExtractionSchemas(projectContextId) {
      if (projectContextId !== id.project) return null
      return [{
        extractionSchemaId: id.schema,
        name: 'Places',
        createdAt: at(3),
        currentRevision: {
          schemaRevisionId: id.revision,
          revisionNumber: 4,
          origin: 'researcher-edit',
          createdAt: at(4),
        },
      }]
    },
    async listSchemaRevisions() {
      return [{
        schemaRevisionId: id.revision,
        extractionSchemaId: id.schema,
        revisionNumber: 4,
        origin: 'researcher-edit',
        schemaTree: fixtureSchema,
        recordScope: 'document',
        createdAt: at(4),
        stabilisedAt: null,
      }]
    },
    async getSchemaRevision(projectContextId, extractionSchemaId, schemaRevisionId) {
      if (
        projectContextId !== id.project ||
        extractionSchemaId !== id.schema ||
        schemaRevisionId !== id.revision
      )
        return null
      return {
        schemaRevisionId: id.revision,
        extractionSchemaId: id.schema,
        revisionNumber: 4,
        origin: 'researcher-edit',
        schemaTree: fixtureSchema,
        recordScope: 'document',
        createdAt: at(4),
        stabilisedAt: null,
      }
    },
    initializeSchemaRevision: unsupported,
    appendSchemaRevision: unsupported,
  }
  const extractions = {
    runSingle: unsupported,
    readExtractionAttempt: unsupported,
    readDocumentExtractions: unsupported,
    scheduleSuggestedBatch: unsupported,
    stabiliseSchemaRevision: unsupported,
    async scheduleBatch() {
      batch = { batchExtractionId: crypto.randomUUID() } as BatchExtractionSnapshot
      readsWhileQueued = 0
      batch = snapshot(false)
      return { disposition: 'created' as const, batch }
    },
    async listBatches() {
      if (!batch) return []
      // The worker finishes between polls, so the panel renders queued first.
      if (batch.executionStatus === 'QUEUED' && ++readsWhileQueued > 1)
        batch = snapshot(true)
      return [batch]
    },
    async readBatch() {
      if (!batch) throw new Error('Batch Extraction not opened.')
      return batch
    },
  } as ExtractionModule
  return { store, extractions }
}

/** Browser-facing fixture responses over the same shipped JSON contracts. */
async function stubStudio(page: Page, nested = false): Promise<void> {
  const { store, extractions } = batchFixture(nested)
  const projectContexts = createGetProjectContexts(store)
  const extractionSchemas = createGetExtractionSchemas(store)
  const schemaRevisions = createSchemaRevisionHandlers(store)
  const batchExtractions = createBatchFixtureHandler(extractions)

  const serve = async (
    route: Parameters<Parameters<Page['route']>[1]>[0],
    handler: (request: Request) => Promise<Response>,
  ) => {
    const request = route.request()
    const body = request.postDataBuffer()
    const response = await handler(
      new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: body ? new Uint8Array(body) : undefined,
      }),
    )
    await route
      .fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      })
      .catch(() => {})
  }

  await page.route('**/api/project-contexts**', (route) => serve(route, projectContexts))
  await page.route('**/api/extraction-schemas**', (route) => serve(route, extractionSchemas))
  await page.route('**/api/schema-revisions**', (route) =>
    serve(route, route.request().method() === 'POST' ? schemaRevisions.POST : schemaRevisions.GET),
  )
  await page.route('**/api/batch-extractions**', (route) => serve(route, batchExtractions))
  // No suggestion has been requested in this Project Context.
  await page.route('**/api/batch-schema-suggestions**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ batchSchemaSuggestions: [] }),
    }),
  )
}

const panel = (page: Page) => page.getByRole('tabpanel', { name: 'Extractions' })

/**
 * Opens the Extractions tab with the Project Context's Source Documents already
 * read, which is what the panel offers a new Batch Extraction over.
 */
async function openExtractions(page: Page): Promise<void> {
  await gotoAuthenticated(page, `/projects/${id.project}`)
  const project = page.getByRole('region', { name: 'Project' })
  for (const name of Object.values(documentName))
    await expect(project.getByText(name, { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Extractions' }).click()
}

/** The prepare screen, over every Source Document in the Project Context. */
async function prepareBatch(page: Page): Promise<void> {
  await panel(page).getByRole('button', { name: 'New Batch Extraction' }).click()
  await expect(panel(page).getByText('2 selected')).toBeVisible()
}

async function stubSharedSuggestionDraft(
  page: Page,
  shared: { suggestion: ReturnType<typeof readySuggestionDto> },
): Promise<void> {
  await page.route('**/api/batch-schema-suggestions**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET')
      return route.fulfill({
        json: path.endsWith('/api/batch-schema-suggestions')
          ? { batchSchemaSuggestions: [shared.suggestion] }
          : { batchSchemaSuggestion: shared.suggestion },
      })
    if (request.method() === 'PATCH' && path.endsWith('/draft')) {
      const body = request.postDataJSON() as {
        expectedDraftVersion: number
        recordDescription: string
        schemaNodes: typeof schemaTree.schemaNodes
      }
      if (body.expectedDraftVersion !== shared.suggestion.draftVersion)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'draft_conflict',
              message: 'The saved suggestion draft changed in another tab.',
            },
          },
        })
      shared.suggestion = readySuggestionDto(
        {
          recordDescription: body.recordDescription,
          schemaNodes: body.schemaNodes,
        },
        body.expectedDraftVersion + 1,
      )
      return route.fulfill({
        json: { batchSchemaSuggestion: shared.suggestion },
      })
    }
    return route.fulfill({ status: 405, body: 'Method not allowed' })
  })
}

async function expectBatchRunClearOfSession(page: Page): Promise<void> {
  const run = panel(page).getByRole('button', {
    name: 'Run 2 Source Documents',
  })
  await run.scrollIntoViewIfNeeded()
  const scrollRegion = page
    .getByRole('region', { name: 'Project' })
    .locator('.scrollbar-subtle')
    .first()
  await scrollRegion.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const [runBox, viewport] = await Promise.all([
    run.boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ])
  expect(runBox).not.toBeNull()
  if (!runBox) return
  expect(runBox.x).toBeGreaterThanOrEqual(0)
  expect(runBox.y).toBeGreaterThanOrEqual(0)
  expect(runBox.x + runBox.width).toBeLessThanOrEqual(viewport.width)
  expect(runBox.y + runBox.height).toBeLessThanOrEqual(viewport.height)
  const session = page.getByRole('button', { name: /Researcher Account/ })
  const sessionBox =
    (await session.count()) === 0 ? null : await session.boundingBox()
  if (sessionBox) {
    const overlapsSession = !(
      runBox.x + runBox.width <= sessionBox.x ||
      sessionBox.x + sessionBox.width <= runBox.x ||
      runBox.y + runBox.height <= sessionBox.y ||
      sessionBox.y + sessionBox.height <= runBox.y
    )
    expect(overlapsSession).toBe(false)
  }
  await expect(run).toBeEnabled()
}


test('Batch Builder Run stays operable at every required viewport and a 200% zoom-equivalent viewport @deterministic', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await stubStudio(page)
  await openExtractions(page)
  await prepareBatch(page)

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 859, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expectBatchRunClearOfSession(page)
  }

  await emulateBrowserZoom200(page)
  await expectBatchRunClearOfSession(page)
})

for (const key of ['Enter', 'Space'] as const) {
  test(`Batch Builder Run activates with ${key} @deterministic`, async ({
    page,
  }) => {
    await stubStudio(page)
    await openExtractions(page)
    await prepareBatch(page)
    const run = panel(page).getByRole('button', {
      name: 'Run 2 Source Documents',
    })
    await expect(run).toBeEnabled()
    await run.focus()
    await expect(run).toBeFocused()
    const runRequests: string[] = []
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/batch-extractions'
      )
        runRequests.push(request.url())
    })
    const opened = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/batch-extractions',
    )
    await run.press(key)
    expect((await opened).postDataJSON()).toMatchObject({
      projectContextId: id.project,
      schemaRevisionId: id.revision,
      strategy: 'ARTICLE',
      sourceDocumentIds: [id.beretning, id.fundliste],
    })
    await expect(
      panel(page).getByRole('button', {
        name: /Places · Schema Revision 4/,
      }),
    ).toBeVisible()
    expect(runRequests).toHaveLength(1)
  })
}

test('two tabs expose and recover a durable Batch Schema Suggestion draft conflict @deterministic', async ({
  page,
  context,
}) => {
  const shared = { suggestion: readySuggestionDto() }
  const otherPage = await context.newPage()
  for (const candidate of [page, otherPage]) {
    await stubStudio(candidate)
    await stubSharedSuggestionDraft(candidate, shared)
    await openExtractions(candidate)
    await prepareBatch(candidate)
    await candidate
      .getByRole('combobox', { name: 'Extraction Schema', exact: true })
      .selectOption('__suggest_common_fields__')
    await expect(candidate.getByText('place', { exact: true })).toBeVisible()
  }

  const firstSuggestion = page.getByLabel('Suggested common fields')
  // A row's actions show, and take the pointer, on hover (§6).
  await firstSuggestion.getByRole('listitem', { name: 'place' }).hover()
  await firstSuggestion.getByRole('button', { name: 'Edit place', exact: true }).click()
  await firstSuggestion.getByPlaceholder('field_name').fill('city')
  await firstSuggestion.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => shared.suggestion.draftVersion).toBe(1)

  const secondSuggestion = otherPage.getByLabel('Suggested common fields')
  await secondSuggestion.getByRole('listitem', { name: 'place' }).hover()
  await secondSuggestion.getByRole('button', { name: 'Edit place', exact: true }).click()
  await secondSuggestion.getByPlaceholder('field_name').fill('town')
  await secondSuggestion.getByRole('button', { name: 'Save' }).click()
  await expect(
    otherPage.getByText('This draft changed in another tab.'),
  ).toBeVisible()
  await expect(
    otherPage.getByRole('button', { name: 'Run 2 Source Documents' }),
  ).toBeDisabled()

  await otherPage.getByRole('button', { name: 'Reload saved draft' }).click()
  await expect(secondSuggestion.getByText('city', { exact: true })).toBeVisible()
  await expect(secondSuggestion.getByText('town', { exact: true })).toHaveCount(0)
  await expect(
    otherPage.getByRole('button', { name: 'Run 2 Source Documents' }),
  ).toBeEnabled()
})
