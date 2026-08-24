import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import type { BatchExtractionSnapshot, ExtractionModule } from 'extraction'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { createGetExtractionSchemas } from '../api/extraction_schemas.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { createSchemaRevisionHandlers } from '../api/schema_revisions.js'
import { gotoAuthenticated } from './auth.js'

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
function batchFixture(): {
  store: StudioStore
  extractions: ExtractionModule
} {
  let batch: BatchExtractionSnapshot | null = null
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
      return [project]
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
        schemaTree,
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
        schemaTree,
        createdAt: at(4),
      }
    },
    initializeSchemaRevision: unsupported,
    appendSchemaRevision: unsupported,
  }
  const extractions = {
    runSingle: unsupported,
    cancelSingle: unsupported,
    prepareReview: unsupported,
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
async function stubStudio(page: Page): Promise<void> {
  const { store, extractions } = batchFixture()
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
  const project = page.getByRole('region', { name: 'Project Context' })
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
  await expect(panel(page).getByRole('button', { name: 'Export' })).toBeEnabled({
    timeout: 15_000,
  })
})
