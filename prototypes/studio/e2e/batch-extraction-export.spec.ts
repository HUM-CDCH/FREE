import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import type { BatchExtractionSnapshot, ExtractionModule } from 'extraction'
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

/** What each member's Extraction stored. Non-ASCII proves the encoding survives. */
const results = [
  {
    sourceDocumentId: id.beretning,
    extractionId: id.beretningExtraction,
    result: { records: [{ place: 'Ellekilde', year: 1801 }] },
  },
  {
    sourceDocumentId: id.fundliste,
    extractionId: id.fundlisteExtraction,
    result: { records: [{ place: 'Hørsholm', year: 1802 }] },
  },
]

function readySuggestionDto(
  draft = schemaTree,
  draftVersion = 0,
) {
  return {
    batchSchemaSuggestionId: '74000000-0000-4000-8008-000000000001',
    projectContextId: id.project,
    selectionKey: 'a'.repeat(64),
    executionStatus: 'COMPLETED',
    phase: 'READY',
    proposal: schemaTree,
    coverage: schemaTree.schemaNodes.map((node) => ({
      nodeId: node.id,
      present: 2,
      total: 2,
    })),
    draft,
    draftVersion,
    failure: null,
    confirmedSchemaRevisionId: null,
    batchExtractionId: null,
    startedAt: '2026-08-19T10:00:00.000Z',
    finishedAt: '2026-08-19T10:00:01.000Z',
    createdAt: '2026-08-19T10:00:00.000Z',
    sources: [
      [id.beretning, id.beretningRevision],
      [id.fundliste, id.fundlisteRevision],
    ].map(([sourceDocumentId, sourceRepresentationRevisionId]) => ({
      sourceDocumentId,
      sourceRepresentationRevisionId,
      executionStatus: 'COMPLETED',
      definition: schemaTree,
      failure: null,
      startedAt: '2026-08-19T10:00:00.000Z',
      finishedAt: '2026-08-19T10:00:01.000Z',
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
    executionFailureMessage: batch.failureMessage,
    startedAt: batch.startedAt?.toISOString() ?? null,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    createdAt: batch.createdAt.toISOString(),
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId:
        member.sourceRepresentationRevisionId,
      executionStatus: member.executionStatus,
      executionFailureMessage: member.failureMessage,
      startedAt: member.startedAt?.toISOString() ?? null,
      finishedAt: member.finishedAt?.toISOString() ?? null,
      latestExtraction: member.latestExtraction && {
        extractionId: member.latestExtraction.extractionId,
        outcome: member.latestExtraction.outcome,
        complete: member.latestExtraction.complete,
        reviewable: member.latestExtraction.reviewable,
        createdAt: member.latestExtraction.createdAt.toISOString(),
        reviewedAt:
          member.latestExtraction.reviewedAt?.toISOString() ?? null,
        failureMessage: member.latestExtraction.failureMessage,
      },
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
    const results =
      /^\/api\/batch-extractions\/([^/]+)\/results$/.exec(
        url.pathname,
      )
    const projectContextId = url.searchParams.get('projectContextId')!
    if (results)
      return Response.json(
        await extractions.readBatchResults({
          projectContextId,
          batchExtractionId: results[1]!,
        }),
      )
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
    failureMessage: null,
    startedAt: finished ? at(43) : null,
    finishedAt: finished ? at(44) : null,
    latestExtraction: finished
      ? {
          extractionId,
          outcome: 'SUCCEEDED' as const,
          complete: true,
          reviewable: true,
          createdAt: at(44),
          reviewedAt: null,
          failureMessage: null,
        }
      : null,
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
    failureMessage: null,
    startedAt: finished ? at(43) : null,
    finishedAt: finished ? at(45) : null,
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
        createdAt: at(4),
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
        createdAt: at(4),
      }
    },
    initializeSchemaRevision: unsupported,
    appendSchemaRevision: unsupported,
  }
  const extractions = {
    runSingle: unsupported,
    readExtractionAttempt: unsupported,
    cancelSingle: unsupported,
    prepareReview: unsupported,
    resetReview: async (_id, version) => ({ version: version + 1, decisions: [] }),
    readReviewDraft: async () => ({ version: 0, decisions: [] }),
    saveReviewDraft: async (_id, draft) => ({ ...draft, version: draft.version + 1 }),
    finalizeReview: unsupported,
    readDocumentExtractions: unsupported,
    scheduleSuggestedBatch: unsupported,
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
    async readBatchResults() {
      if (!batch) throw new Error('Batch Extraction not opened.')
      const produced = batch.executionStatus === 'COMPLETED' ? results : []
      return {
        batchExtractionId: batch.batchExtractionId,
        executionStatus: batch.executionStatus,
        totalMembers: batch.members.length,
        successfulResults: produced.length,
        pending: batch.executionStatus === 'COMPLETED' ? 0 : batch.members.length,
        failed: 0,
        cancelled: 0,
        results: produced,
      }
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

/** One Source Document's own selection control, inside its row. */
const documentCheckbox = (page: Page, name: string) =>
  panel(page)
    .getByRole('listitem')
    .filter({ hasText: name })
    .getByRole('checkbox')

/** The prepare screen, over every Source Document in the Project Context. */
async function prepareBatch(page: Page): Promise<void> {
  await panel(page).getByRole('button', { name: 'New Batch Extraction' }).click()
  await expect(panel(page).getByText('2 selected')).toBeVisible()
}

/** Opens the export popover on the member list and downloads the chosen format. */
async function exportBatch(page: Page, format: 'Excel' | 'CSV') {
  const trigger = panel(page).getByRole('button', { name: 'Export' })
  await trigger.click()
  const options = page.getByRole('dialog', { name: 'Export options' })
  const rowsRepresent = options.getByLabel('Rows represent')
  await expect(rowsRepresent).toHaveValue('$')
  await expect(rowsRepresent).toBeFocused()
  await expect(options.getByLabel('Other repeated fields')).toHaveValue('preserve')
  const download = page.waitForEvent('download')
  await options.getByRole('button', { name: format }).click()
  const completed = await download
  await expect(trigger).toBeFocused()
  return completed
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

test('a Batch Extraction runs over selected Source Documents and exports one spreadsheet @deterministic', async ({
  page,
}) => {
  await stubStudio(page)
  await openExtractions(page)

  // Open the batch over both Source Documents, through the saved Schema Revision.
  await prepareBatch(page)
  await expect(
    panel(page).getByRole('combobox', { name: /Extraction Schema/ }),
  ).toHaveValue(id.revision)
  for (const name of Object.values(documentName))
    await expect(documentCheckbox(page, name)).toBeChecked()
  await panel(page).getByRole('button', { name: 'Run 2 Source Documents' }).click()

  // The history row carries the batch from opened, through running, to finished.
  const historyRow = panel(page).getByRole('button', {
    name: /Places · Schema Revision 4/,
  })
  await expect(historyRow).toContainText('2 Source Documents · Article')
  await expect(historyRow).toContainText(/Queued|Running/)
  await expect(historyRow).toContainText('2 need review', { timeout: 15_000 })
  const completionDialog = page.getByRole('dialog', { name: 'Batch Extraction finished' })
  await expect(completionDialog).toBeVisible()
  await completionDialog.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(completionDialog).toBeHidden()

  // Every member is listed with what its own Extraction says.
  await historyRow.click()
  const members = panel(page).getByRole('list', { name: 'Batch Extraction members' })
  await expect(members.getByRole('listitem')).toHaveCount(2)
  await expect(members.getByRole('button', { name: /Beretning_Ellekilde_8_13\.pdf/ })).toContainText(
    'Needs review',
  )
  await expect(members.getByRole('button', { name: /Fundliste_Ellekilde\.pdf/ })).toContainText(
    'Needs review',
  )

  // Excel: one workbook over the whole batch, each row naming its Source Document.
  const workbookDownload = await exportBatch(page, 'Excel')
  expect(workbookDownload.suggestedFilename()).toMatch(
    /^Places revision 4 batch [0-9a-f]{8}-batch-extraction-results\.xlsx$/,
  )
  const archive = unzipSync(new Uint8Array(await readFile((await workbookDownload.path())!)))
  const workbook = Object.fromEntries(
    Object.entries(archive).map(([path, bytes]) => [path, strFromU8(bytes)]),
  )
  expect(workbook['xl/workbook.xml']).toMatch(/<sheet[^>]*name="Results"/)
  for (const value of [
    'Source Document',
    'Source Document ID',
    'Batch Extraction ID',
    'place',
    'year',
    documentName[id.beretning],
    documentName[id.fundliste],
    id.beretning,
    id.fundliste,
    'Ellekilde',
    'Hørsholm',
  ])
    expect(workbook['xl/sharedStrings.xml']).toContain(value)
  const sheet = workbook['xl/worksheets/sheet1.xml']!
  // A header and one row per member, the years as numbers Excel can total.
  expect(sheet.match(/<row/g)).toHaveLength(3)
  expect(sheet).toContain('<autoFilter ref="A1:E3"/>')
  expect(sheet).toMatch(/<v>1801<\/v>/)
  expect(sheet).toMatch(/<v>1802<\/v>/)

  // CSV: the same canonical table as text.
  const csvDownload = await exportBatch(page, 'CSV')
  expect(csvDownload.suggestedFilename()).toMatch(
    /^Places revision 4 batch [0-9a-f]{8}-batch-extraction-results\.csv$/,
  )
  const [header, first, second] = (
    await readFile((await csvDownload.path())!, 'utf8')
  ).split('\r\n')
  expect(header).toBe(
    'Source Document,Source Document ID,Batch Extraction ID,place,year',
  )
  const firstCells = first!.split(',')
  const secondCells = second!.split(',')
  expect(firstCells).toEqual([
    documentName[id.beretning],
    id.beretning,
    expect.stringMatching(/^[0-9a-f-]{36}$/),
    'Ellekilde',
    '1801',
  ])
  expect(secondCells).toEqual([
    documentName[id.fundliste],
    id.fundliste,
    firstCells[2],
    'Hørsholm',
    '1802',
  ])
})

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
  await firstSuggestion.getByTitle('Edit place').click()
  await firstSuggestion.getByPlaceholder('field_name').fill('city')
  await firstSuggestion.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => shared.suggestion.draftVersion).toBe(1)

  const secondSuggestion = otherPage.getByLabel('Suggested common fields')
  await secondSuggestion.getByTitle('Edit place').click()
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

test('the export stays unavailable until the batch has produced a result @deterministic', async ({
  page,
}) => {
  await stubStudio(page)
  await openExtractions(page)

  await prepareBatch(page)
  await panel(page).getByRole('button', { name: 'Run 2 Source Documents' }).click()

  const historyRow = panel(page).getByRole('button', {
    name: /Places · Schema Revision 4/,
  })
  await expect(historyRow).toContainText(/Queued|Running/)
  await historyRow.click()

  // No member has an Extraction yet, so there is nothing to project.
  await expect(panel(page).getByRole('button', { name: 'Export' })).toBeDisabled()
  await expect(panel(page)).not.toContainText('Hørsholm')
  await expect(panel(page).getByRole('button', { name: 'Export' })).toBeEnabled({
    timeout: 15_000,
  })
})

test('the Batch review grid handles member failure, targeted reload, bulk decisions, edit, reject, and save @deterministic', async ({
  page,
}) => {
  await stubStudio(page, true)
  const batchExtractionId = '74000000-0000-4000-8005-000000000001'
  const completedBatch: BatchExtractionSnapshot = {
    batchExtractionId,
    projectContextId: id.project,
    schemaRevisionId: id.revision,
    extractionSchemaId: id.schema,
    extractionSchemaName: 'Places',
    schemaRevisionNumber: 4,
    strategy: 'ARTICLE',
    executionStatus: 'COMPLETED',
    failureMessage: null,
    startedAt: at(43),
    finishedAt: at(45),
    createdAt: at(42),
    members: [
      {
        sourceDocumentId: id.beretning,
        sourceRepresentationRevisionId: id.beretningRevision,
        executionStatus: 'COMPLETED',
        failureMessage: null,
        startedAt: at(43),
        finishedAt: at(44),
        latestExtraction: {
          extractionId: id.beretningExtraction,
          outcome: 'SUCCEEDED',
          complete: true,
          reviewable: true,
          createdAt: at(44),
          reviewedAt: null,
          failureMessage: null,
        },
      },
      {
        sourceDocumentId: id.fundliste,
        sourceRepresentationRevisionId: id.fundlisteRevision,
        executionStatus: 'FAILED',
        failureMessage: 'Grounding failed for this member.',
        startedAt: at(43),
        finishedAt: at(44),
        latestExtraction: null,
      },
    ],
  }
  const attempt = {
    extractionId: id.beretningExtraction,
    sourceDocumentId: id.beretning,
    sourceRepresentationRevisionId: id.beretningRevision,
    schemaRevisionId: id.revision,
    strategy: 'ARTICLE' as const,
    executionStatus: 'COMPLETED' as const,
    outcome: 'SUCCEEDED' as const,
    complete: true,
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    diagnostics: {
      phase: 'grounding' as const,
      durationMs: 1,
      modelCalls: 1,
      finishReason: 'stop',
      inputTokens: 1,
      outputTokens: 1,
      grounding: null,
      catalog: null,
    },
    failure: null,
    resultPayload: { records: [{ place: 'Ellekilde', year: 1801, finds: [{ material: 'Bronze' }, { material: 'Iron' }] }] },
    evidenceLinks: [
      { resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' },
      { resultPath: ['records', 0, 'year'], evidenceAnchorId: 'anchor-year' },
      { resultPath: ['records', 0, 'finds', 0, 'material'], evidenceAnchorId: 'anchor-bronze' },
      { resultPath: ['records', 0, 'finds', 1, 'material'], evidenceAnchorId: 'anchor-iron' },
    ],
    reviewable: true,
    batchExtractionId,
    createdAt: at(44).toISOString(),
    reviewedAt: null as string | null,
    reviewDecisions: [] as Array<Record<string, unknown>>,
  }
  const pendingReviewDecisions = [
    {
      resultPath: ['records', 0, 'place'],
      evidenceAnchorId: 'anchor-place',
      reviewedOccurrenceIds: ['occurrence-place'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    },
    {
      resultPath: ['records', 0, 'year'],
      evidenceAnchorId: 'anchor-year',
      reviewedOccurrenceIds: ['occurrence-year'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    },
  ]
  let extractionReads = 0
  pendingReviewDecisions.push(...[0, 1].map((index) => ({
    resultPath: ['records', 0, 'finds', index, 'material'],
    evidenceAnchorId: index === 0 ? 'anchor-bronze' : 'anchor-iron',
    reviewedOccurrenceIds: [`occurrence-material-${index}`],
    action: 'APPROVED' as const,
    reviewedValue: null,
  })))
  let savedReview: unknown = null
  let reviewDraft = { version: 0, decisions: [] as Array<Record<string, unknown>> }

  await page.route('**/api/batch-extractions**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/results'))
      return route.fulfill({
        json: {
          batchExtractionId,
          executionStatus: 'COMPLETED',
          totalMembers: 2,
          successfulResults: 1,
          pending: 0,
          failed: 1,
          cancelled: 0,
          results: [results[0]],
        },
      })
    return route.fulfill({
      json: url.pathname === '/api/batch-extractions'
        ? { batchExtractions: [batchDto(completedBatch)] }
        : { batchExtraction: batchDto(completedBatch) },
    })
  })
  await page.route('**/api/extractions/**', async (route) => {
    const request = route.request()
    if (new URL(request.url()).pathname.endsWith('/review/draft')) {
      const input = request.postDataJSON() as typeof reviewDraft
      if (input.version !== reviewDraft.version)
        return route.fulfill({ status: 409, json: { error: { message: 'Draft conflict' } } })
      reviewDraft = { ...input, version: input.version + 1 }
      return route.fulfill({ json: reviewDraft })
    }
    if (request.method() === 'POST') {
      savedReview = request.postDataJSON()
      attempt.reviewedAt = at(46).toISOString()
      attempt.reviewDecisions = (savedReview as { reviewDecisions: Array<Record<string, unknown>> }).reviewDecisions
        .map((decision) => ({ ...decision, createdAt: at(46).toISOString() }))
      return route.fulfill({ json: attempt })
    }
    extractionReads += 1
    if (extractionReads === 1)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'persistence_unavailable', message: 'Review data is temporarily unavailable.' } },
      })
    return route.fulfill({
      json: { extraction: attempt, pendingReviewDecisions, reviewDraft },
    })
  })

  await openExtractions(page)
  await panel(page).getByRole('button', { name: /Places · Schema Revision 4/ }).click()
  const members = panel(page).getByRole('list', { name: 'Batch Extraction members' })
  await expect(members).toContainText('Grounding failed for this member.')
  const reviewGrid = panel(page).getByRole('button', { name: 'Review grid' })
  await expect(reviewGrid).toBeEnabled()
  await reviewGrid.click()

  await expect(page.getByText('Review data is temporarily unavailable.')).toBeVisible()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('Ellekilde', { exact: true })).toBeVisible()

  await expect(page.getByRole('button', { name: /Save completed/ })).toHaveCount(0)
  await page.getByText('Ellekilde', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const placeInput = page.locator('input[value="Ellekilde"]')
  await placeInput.fill('Milan')
  await placeInput.press('Enter')
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Back to results/ }).click()
  await panel(page).getByRole('button', { name: 'Review grid' }).click()
  await expect(page.getByText('Milan', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('Milan', { exact: true })).toBeVisible()
  await page.getByText('1801', { exact: true }).click()
  await page.getByRole('button', { name: 'Reject', exact: true }).click()
  const material = page.getByRole('group', { name: 'material · Item 1', exact: true })
  await material.getByRole('button', { name: 'Bronze', exact: true }).click()
  await material.getByRole('button', { name: 'Edit', exact: true }).click()
  await material.getByRole('textbox').fill('Copper')
  await material.getByRole('textbox').press('Enter')
  expect(savedReview).toBeNull()
  await page.getByRole('button', { name: 'Approve remaining', exact: true }).click()
  await expect(page.getByText('Review saved', { exact: true })).toBeVisible()
  expect(savedReview).toMatchObject({
    reviewDecisions: expect.arrayContaining([
      expect.objectContaining({ reviewedValue: 'Milan' }),
      expect.objectContaining({ action: 'REJECTED' }),
      expect.objectContaining({ resultPath: ['records', 0, 'finds', 0, 'material'], reviewedValue: 'Copper' }),
      expect.objectContaining({ resultPath: ['records', 0, 'finds', 1, 'material'], action: 'APPROVED' }),
    ]),
  })
  await page.getByRole('button', { name: /Back to results/ }).click()
  await expect(panel(page).getByRole('list', { name: 'Batch Extraction members' })).toBeVisible()
})
