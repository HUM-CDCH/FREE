import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ExtractionModule } from 'extraction'
import {
  emptyProjectContextActivitySummary,
  type ResearcherProjectStore,
} from '../../../packages/db/src/project-store.js'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { batchExtractionSchema } from '../shared/batchExtraction.contract.js'
import {
  DEMO_DOCUMENT_ID,
  DEMO_PROJECT_ID,
  DEMO_REPRESENTATION_ID,
} from '../api/project_contexts.fixture.js'
import { gotoAuthenticated } from './auth.js'
import {
  activateWithKeyboard,
  emulateBrowserZoom200,
  expectOperableInViewport,
  REQUIRED_VIEWPORTS,
} from './accessibility.js'

const sourcePdf = fileURLToPath(
  new URL('./fixtures/Beretning_Elmbrooke_8_13.pdf', import.meta.url),
)
const parsedDocument = await readFile(
  fileURLToPath(
    new URL('../src/assets/parsed_document.v2.json', import.meta.url),
  ),
  'utf8',
)

const ELMBROOKE = DEMO_PROJECT_ID
const HORSHOLM = '00000000-0000-4000-8000-000000000144'
const BERETNING = DEMO_DOCUMENT_ID
const FUNDLISTE = '00000000-0000-4000-8000-000000000046'
const OVERSIGT = '00000000-0000-4000-8000-000000000146'
const REPRESENTATIONS: Record<string, string> = {
  [BERETNING]: DEMO_REPRESENTATION_ID,
  [FUNDLISTE]: '00000000-0000-4000-8000-0000000000a2',
  [OVERSIGT]: '00000000-0000-4000-8000-0000000000a3',
}

/** Two persisted Project Contexts, newest-created first as the store orders them. */
const SEED = [
  {
    projectContextId: HORSHOLM,
    name: 'Harrowmere, TAK 9402',
    createdAt: '2026-08-02T09:00:00.000Z',
    sourceDocuments: [
      {
        sourceDocumentId: OVERSIGT,
        name: 'Oversigt_Hoersholm.pdf',
        createdAt: '2026-08-02T09:01:00.000Z',
        pageCount: 3,
      },
    ],
  },
  {
    projectContextId: ELMBROOKE,
    name: 'Elmbrooke, TAK 9355',
    createdAt: '2026-07-31T12:00:00.000Z',
    sourceDocuments: [
      {
        sourceDocumentId: BERETNING,
        name: 'Beretning_Elmbrooke_8_13.pdf',
        createdAt: '2026-07-31T12:01:00.000Z',
        pageCount: 6,
      },
      {
        sourceDocumentId: FUNDLISTE,
        name: 'Fundliste_Elmbrooke.pdf',
        createdAt: '2026-07-31T12:02:00.000Z',
        pageCount: 2,
      },
    ],
  },
]


const seedOf = (projectContextId: string) =>
  SEED.find((seed) => seed.projectContextId === projectContextId)
const summary = (seed: (typeof SEED)[number]) => ({
  projectContextId: seed.projectContextId,
  name: seed.name,
  createdAt: new Date(seed.createdAt),
})
const documents = (seed: (typeof SEED)[number]) =>
  seed.sourceDocuments.map((document) => ({
    ...document,
    createdAt: new Date(document.createdAt),
  }))

type NavigationStore = Pick<
  ResearcherProjectStore,
  | 'listProjectContexts'
  | 'getProjectContextWithDocuments'
  | 'getDocumentReopenSnapshot'
>

type ReopenExtractions = Pick<
  ExtractionModule,
  'readDocumentExtractions'
>

const emptyExtractions: ReopenExtractions = {
  async readDocumentExtractions({ sourceDocumentId }) {
    const sourceRepresentationRevisionId = REPRESENTATIONS[sourceDocumentId]
    return sourceRepresentationRevisionId
      ? {
          sourceRepresentationRevisionId,
          latestAttempt: null,
          latestReviewed: null,
        }
      : null
  },
}

const base: NavigationStore = {
  async listProjectContexts(limit) {
    return SEED.slice(0, limit).map((seed) => ({
      ...summary(seed),
      sourceDocumentCount: seed.sourceDocuments.length,
      summary: emptyProjectContextActivitySummary(summary(seed).createdAt),
    }))
  },
  async getProjectContextWithDocuments(projectContextId) {
    const seed = seedOf(projectContextId)
    return seed
      ? { projectContext: summary(seed), sourceDocuments: documents(seed) }
      : null
  },
  async getDocumentReopenSnapshot(projectContextId, sourceDocumentId) {
    const seed = seedOf(projectContextId)
    const document = seed
      ? documents(seed).find(
          (item) => item.sourceDocumentId === sourceDocumentId,
        )
      : undefined
    if (!seed || !document) return null
    return {
      projectContext: summary(seed),
      sourceDocument: {
        sourceDocumentId: document.sourceDocumentId,
        name: document.name,
        createdAt: document.createdAt,
      },
      sourceRepresentation: {
        sourceRepresentationId: REPRESENTATIONS[sourceDocumentId],
        revisionNumber: 2,
        createdAt: document.createdAt,
      },
      annotationSet: null,
      extractionSchema: null,
    }
  },
}

const railStore = (
  overrides: Partial<NavigationStore> = {},
): NavigationStore => ({
  ...base,
  ...overrides,
})

type Studio = {
  /** Every `/api` path the browser attempted, stubbed or not. */
  requests: string[]
  /** Paths the browser cancelled before they settled. */
  cancelled: string[]
  /** Reopen DTOs exactly as the browser received them. */
  snapshots: { sourceRepresentation: { resources: Record<string, string> } }[]
  /** Hold every request whose path contains `pattern` until the returned release. */
  hold(pattern: string): () => void
  /** Studio's Source Ingestions per Project Context, as the listing serves them; empty unless a test adds rows. */
  ingestions: Map<string, Record<string, unknown>[]>
  /** Workflow IDs the browser dismissed. */
  dismissed: string[]
}

/**
 * The persisted reads Studio would serve from PostgreSQL, composed by the real
 * handlers so the browser reads the shipped contract — DTOs, status codes and
 * bounded failures alike. Only the retained artifacts are served directly,
 * standing in for the Parsing Service.
 */
async function stubStudio(
  page: Page,
  options: {
    store?: NavigationStore
    extractions?: ReopenExtractions
    artifacts?: 'unavailable'
  } = {},
): Promise<Studio> {
  const store = options.store ?? railStore()
  const projectContexts = createGetProjectContexts(store)
  const reopen = createGetDocumentReopen(
    store,
    options.extractions ?? emptyExtractions,
  )
  const requests: string[] = []
  const cancelled: string[] = []
  const snapshots: Studio['snapshots'] = []
  const holds = new Map<string, Promise<void>>()

  // Recorded from the browser rather than from the stubs, so a request to an
  // unstubbed path still counts as having reached the server.
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.startsWith('/api/')) requests.push(pathname)
  })
  page.on('requestfailed', (request) =>
    cancelled.push(new URL(request.url()).pathname),
  )

  await page.route('**/api/project-contexts**', async (route) => {
    const url = route.request().url()
    const { pathname } = new URL(url)
    await Promise.all(
      [...holds]
        .filter(([pattern]) => pathname.includes(pattern))
        .map(([, held]) => held),
    )
    const reopening = pathname.endsWith('/reopen')
    const response = await (reopening ? reopen : projectContexts)(
      new Request(url),
    )
    const body = await response.text()
    if (reopening && response.ok) snapshots.push(JSON.parse(body))
    await route
      .fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body,
      })
      // A superseded read is aborted mid-flight; fulfilling it then fails.
      .catch(() => {})
  })

  // Studio's Source Ingestions: the listing (GET, with named IDs) and dismissal (DELETE), from memory.
  const ingestions = new Map<string, Record<string, unknown>[]>()
  const dismissed: string[] = []
  await page.route('**/api/project-contexts/*/source-ingestions**', async (route) => {
    const url = new URL(route.request().url())
    const [, , , projectContextId, , encoded] = url.pathname.split('/')
    const rows = ingestions.get(projectContextId!) ?? []
    const settle = (fulfill: Parameters<typeof route.fulfill>[0]) => route.fulfill(fulfill).catch(() => {})
    if (route.request().method() === 'DELETE') {
      const workflowId = decodeURIComponent(encoded ?? '')
      dismissed.push(workflowId)
      ingestions.set(projectContextId!, rows.filter((row) => row.workflowId !== workflowId))
      return settle({ status: 204, headers: { 'cache-control': 'no-store' } })
    }
    const named = url.searchParams.getAll('workflowId')
    return settle({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ ingestions: rows, absent: named.filter((id) => !rows.some((row) => row.workflowId === id)) }),
    })
  })

  await page.route(
    '**/api/project-contexts/*/source-representations/**',
    async (route) => {
      const { pathname } = new URL(route.request().url())
      const settle = (fulfill: Parameters<typeof route.fulfill>[0]) =>
        route.fulfill(fulfill).catch(() => {})
      if (options.artifacts === 'unavailable')
        return settle({
          status: 503,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: JSON.stringify({
            error: {
              code: 'source_artifact_unavailable',
              message: 'The retained Source Document artifact is unavailable.',
            },
          }),
        })
      const immutable = {
        'cache-control': 'private, max-age=31536000, immutable',
      }
      if (pathname.endsWith('/pdf'))
        return settle({
          path: sourcePdf,
          contentType: 'application/pdf',
          headers: immutable,
        })
      if (pathname.endsWith('/source'))
        return settle({
          body: parsedDocument,
          contentType: 'application/json',
          headers: immutable,
        })
      return settle({
        body: '# Beretning\n\nUnit 7',
        contentType: 'text/markdown; charset=utf-8',
        headers: immutable,
      })
    },
  )

  return {
    requests,
    cancelled,
    snapshots,
    ingestions,
    dismissed,
    hold(pattern) {
      let release!: () => void
      holds.set(
        pattern,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      return () => {
        holds.delete(pattern)
        release()
      }
    },
  }
}

const rail = (page: Page) =>
  page.getByRole('navigation', { name: 'Projects' })
const workspace = (page: Page) =>
  page.getByRole('region', { name: 'Source Document' })
/** The unrouted landing page: a card per Project Context. */
const home = (page: Page) => page.getByRole('region', { name: 'Projects' })
/** The management page for the routed Project Context. */
const projectPage = (page: Page) =>
  page.getByRole('region', { name: 'Project' })
const projectRows = (page: Page) => rail(page).locator('[data-project-row]')
/** The row's chevron+name control; it only discloses, from either part of it. */
const disclosure = (page: Page, name: string) =>
  rail(page).getByRole('button', {
    name: new RegExp(`Source Documents in ${name}$`),
  })
/** The row's "•••" menu trigger. */
const projectMenuTrigger = (page: Page, name: string) =>
  rail(page).getByRole('button', { name: `Actions for ${name}` })
/** Opens the row's menu and follows its "Open project" action. */
const openProject = async (page: Page, name: string) => {
  await projectMenuTrigger(page, name).click()
  await rail(page).getByRole('button', { name: 'Open project' }).click()
}
// The page lists the same Source Documents as cards, so navigation rows are
// always addressed inside the rail.
const documentRow = (page: Page, name: string) =>
  rail(page).getByRole('button', { name, exact: true })

test.describe('rail navigation', () => {
  test('reprocesses a retained PDF with an explicit layout and preserves the retry key', async ({
    page,
  }) => {
    await stubStudio(page)
    const requests: Array<Record<string, unknown>> = []
    await page.route('**/reprocess', async (route) => {
      requests.push(route.request().postDataJSON())
      if (requests.length === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'source_ingestion_failed',
              message: 'Parser temporarily unavailable.',
            },
          },
        })
      return route.fulfill({
        status: 201,
        json: {
          sourceDocumentId: BERETNING,
          name: 'Beretning_Elmbrooke_8_13.pdf',
          createdAt: '2026-07-31T12:01:00.000Z',
          sourceRepresentationId: REPRESENTATIONS[BERETNING],
          revisionNumber: 2,
          pageCount: 6,
        },
      })
    })
    await gotoAuthenticated(page, `/projects/${ELMBROOKE}`)
    const action = page.getByRole('button', {
      name: 'Reprocess Beretning_Elmbrooke_8_13.pdf',
      exact: true,
      includeHidden: true,
    })
    const menu = page.locator('details').filter({ has: action })
    await menu.locator('summary').click()
    await action.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(
      'Existing extractions and reviews keep their original evidence',
    )
    await dialog.getByLabel('PDF layout').selectOption('spreads')
    await dialog.getByRole('button', { name: 'Reprocess', exact: true }).click()
    await expect(
      page.getByText('Parser temporarily unavailable.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: /Retry/ }).click()
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({
      expectedRepresentationId: REPRESENTATIONS[BERETNING],
      layout: 'spreads',
    })
  })

  test('a failed Project Context write preserves the keyboard draft and retries cleanly', async ({
    page,
  }) => {
    await stubStudio(page)
    let unavailable = true
    let writes = 0
    await page.route('**/api/project-contexts', async (route) => {
      const request = route.request()
      if (request.method() !== 'POST') return route.fallback()
      writes += 1
      if (unavailable)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          json: {
            error: {
              code: 'persistence_unavailable',
              message: 'Project Context storage is unavailable.',
            },
          },
        })
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        json: {
          projectContext: {
            projectContextId: '00000000-0000-4000-8000-000000000047',
            name: 'Recovered project',
            createdAt: '2026-08-24T10:00:00.000Z',
          },
        },
      })
    })
    await gotoAuthenticated(page, '/')

    const create = page.getByRole('button', { name: 'New Project', exact: true })
    await activateWithKeyboard(page, create)
    const name = page.getByRole('textbox', { name: 'Project name' })
    await expect(name).toBeFocused()
    await page.keyboard.type('Recovered project')
    await activateWithKeyboard(
      page,
      page.getByRole('button', { name: 'Create', exact: true }),
    )

    const dialog = page.getByRole('dialog', { name: 'New Project', exact: true })
    await expect(dialog).toBeVisible()
    await expect(name).toHaveValue('Recovered project')
    await expect(dialog.getByRole('alert')).toHaveText(
      'Project Context storage is unavailable.',
    )
    await expect(name).toBeFocused()
    unavailable = false
    await activateWithKeyboard(
      page,
      dialog.getByRole('button', { name: 'Create', exact: true }),
    )

    await expect(dialog).toBeHidden()
    // A successful create routes into the created Project Context.
    await expect(page).toHaveURL(
      /\/projects\/00000000-0000-4000-8000-000000000047$/,
    )
    await expect(
      rail(page).getByText('Recovered project', { exact: true }),
    ).toBeVisible()
    expect(writes).toBe(2)
  })

  test('enforces the Unicode filename boundary as an item-scoped browser error', async ({
    page,
  }) => {
    await stubStudio(page)
    let uploads = 0
    await page.route('**/api/project-contexts/*/source-documents', async (route) => {
      uploads += 1
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          sourceDocumentId: '51000000-0000-4000-8001-000000000199',
          name: 'accepted.pdf',
          createdAt: '2026-08-24T09:00:00.000Z',
          sourceRepresentationId: '51000000-0000-4000-8002-000000000199',
          revisionNumber: 1,
          pageCount: 1,
        }),
      })
    })
    await gotoAuthenticated(page, '/')
    await openProject(page, 'Harrowmere, TAK 9402')
    const acceptedName = `${'😀'.repeat(176)}.pdf`
    const rejectedName = `${'😀'.repeat(177)}.pdf`

    await page.getByLabel('Drop PDFs here or browse').setInputFiles([
      {
        name: acceptedName,
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\n'),
      },
      {
        name: rejectedName,
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\n'),
      },
    ])

    await expect(
      projectPage(page).getByText(
        'The Source Document filename must contain at most 180 Unicode characters.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(documentRow(page, 'accepted.pdf')).toBeVisible()
    expect(uploads).toBe(1)
    await expect(projectPage(page).getByRole('button', { name: /Retry/ })).toHaveCount(0)
  })

  test('an upload Studio could not acknowledge stays item-scoped and retries by keyboard', async ({
    page,
  }) => {
    await stubStudio(page)
    let attempts = 0
    await page.route('**/api/project-contexts/*/source-documents', async (route) => {
      attempts += 1
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          json: {
            error: {
              code: 'persistence_unavailable',
              message: 'Source Document ingestion could not be started.',
            },
          },
        })
      // Studio already holds these bytes: the retry replays their Source Document.
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        json: {
          sourceDocumentId: '51000000-0000-4000-8001-000000000199',
          name: 'unacknowledged.pdf',
          createdAt: '2026-08-24T09:00:00.000Z',
          sourceRepresentationId: '51000000-0000-4000-8002-000000000199',
          revisionNumber: 1,
          pageCount: 1,
        },
      })
    })
    await gotoAuthenticated(page, '/')
    await activateWithKeyboard(page, projectMenuTrigger(page, 'Harrowmere, TAK 9402'))
    await activateWithKeyboard(
      page,
      rail(page).getByRole('button', { name: 'Open project' }),
    )
    await page.getByLabel('Drop PDFs here or browse').setInputFiles({
      name: 'unacknowledged.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n'),
    })

    await expect(
      projectPage(page).getByText('Source Document ingestion could not be started.', { exact: true }),
    ).toBeVisible()
    await activateWithKeyboard(
      page,
      projectPage(page).getByRole('button', { name: /Retry unacknowledged\.pdf/ }),
    )

    await expect(documentRow(page, 'unacknowledged.pdf')).toBeVisible()
    expect(attempts).toBe(2)
  })

  test('a listed failure is dismissed by keyboard', async ({ page }) => {
    const studio = await stubStudio(page)
    await gotoAuthenticated(page, '/')
    const workflowId = `ingest:${HORSHOLM}:51000000-0000-4000-8005-000000000001`
    studio.ingestions.set(HORSHOLM, [{
      workflowId, name: 'refused.pdf', status: 'failed', createdAt: '2026-08-24T09:00:00.000Z',
      completedAt: '2026-08-24T09:05:00.000Z', failure: { code: 'source_ingestion_failed', message: 'kei refused the PDF.' },
    }])
    await activateWithKeyboard(page, projectMenuTrigger(page, 'Harrowmere, TAK 9402'))
    await activateWithKeyboard(page, rail(page).getByRole('button', { name: 'Open project' }))

    await expect(projectPage(page).getByText('kei refused the PDF.', { exact: true })).toBeVisible()
    await activateWithKeyboard(page, projectPage(page).getByRole('button', { name: 'Dismiss refused.pdf' }))
    await expect(projectPage(page).getByText('kei refused the PDF.', { exact: true })).toHaveCount(0)
    expect(studio.dismissed).toEqual([workflowId])
  })

  test('returns focus to the delete control when cancellation closes the dialog', async ({
    page,
  }) => {
    await stubStudio(page)
    await gotoAuthenticated(page, '/')
    await openProject(page, 'Harrowmere, TAK 9402')

    const remove = projectPage(page).getByRole('button', { name: 'Delete' })
    await remove.click()
    const dialog = page.getByRole('dialog', { name: 'Delete project' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await expect(dialog).not.toBeVisible()
    await expect(remove).toBeFocused()
  })

  test('returns focus to create and rename controls when name editing is cancelled', async ({
    page,
  }) => {
    await stubStudio(page)
    await gotoAuthenticated(page, '/')

    const create = page.getByRole('button', { name: 'Create project' })
    await create.click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(create).toBeFocused()

    await openProject(page, 'Harrowmere, TAK 9402')
    const rename = projectPage(page).getByRole('button', { name: 'Rename' })
    await rename.click()
    await page
      .getByRole('textbox', { name: 'Project name' })
      .press('Escape')
    await expect(rename).toBeFocused()
  })

  test('Escape and source-delete cancellation restore each exact opener', async ({
    page,
  }) => {
    await stubStudio(page)
    await gotoAuthenticated(page, '/')

    const create = page.getByRole('button', { name: 'New Project', exact: true })
    await create.click()
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(create).toBeFocused()

    await openProject(page, 'Harrowmere, TAK 9402')
    const pageActions = projectPage(page).getByLabel(
      'Actions for Oversigt_Hoersholm.pdf',
    )
    await pageActions.click()
    await projectPage(page)
      .getByRole('button', {
        name: 'Delete Source Document Oversigt_Hoersholm.pdf',
      })
      .click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(pageActions).toBeFocused()

    const railDocument = documentRow(page, 'Oversigt_Hoersholm.pdf')
    await railDocument.click({ button: 'right' })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(railDocument).toBeFocused()
  })

  test('skip navigation and SPA routes move focus to the project content', async ({
    page,
  }) => {
    await stubStudio(page)
    await gotoAuthenticated(page, '/')

    const skip = page.getByRole('link', { name: 'Skip to content' })
    await page.keyboard.press('Tab')
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Projects' })).toBeFocused()

    await page
      .getByRole('button', { name: 'Harrowmere, TAK 9402', exact: true })
      .click()
    await expect(page.getByRole('region', { name: 'Project', exact: true })).toBeFocused()
  })

  test('moves focus deliberately after successful create and rename writes', async ({
    page,
  }) => {
    await stubStudio(page)
    await page.route('**/api/project-contexts**', async (route) => {
      const request = route.request()
      if (request.method() === 'GET') return route.fallback()
      if (request.method() === 'DELETE')
        return route.fulfill({ status: 204, body: '' })
      const name = (request.postDataJSON() as { name: string }).name.trim()
      if (request.method() === 'POST')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            projectContext: {
              projectContextId: '00000000-0000-4000-8000-000000000047',
              name,
              createdAt: '2026-08-12T00:00:00.000Z',
            },
          }),
        })
      if (request.method() === 'PATCH')
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            projectContext: {
              projectContextId: HORSHOLM,
              name,
              createdAt: SEED[0].createdAt,
            },
          }),
        })
      return route.fallback()
    })
    await gotoAuthenticated(page, '/')

    await page.getByRole('button', { name: 'Create project' }).click()
    await page
      .getByRole('textbox', { name: 'Project name' })
      .fill('Created project')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Create project' }),
    ).toBeFocused()

    await openProject(page, 'Harrowmere, TAK 9402')
    await projectPage(page).getByRole('button', { name: 'Rename' }).click()
    const rename = page.getByRole('textbox', { name: 'Project name' })
    await rename.fill('Renamed project')
    await rename.press('Enter')
    await expect(
      projectPage(page).getByRole('button', { name: 'Rename' }),
    ).toBeFocused()

    // The whole page goes with its Project Context, so a stable rail control
    // takes focus. Creation is modal, so no inline draft can coexist with
    // deletion.
    await projectPage(page).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(
      page.getByRole('button', { name: 'Collapse projects' }),
    ).toBeFocused()
  })

  test('downloads exact PDF bytes once, bounds a later failure, and stays operable at every viewport', async ({
    page,
  }) => {
    const browserDiagnostics: string[] = []
    page.on('console', (message) => browserDiagnostics.push(message.text()))
    page.on('pageerror', (error) => browserDiagnostics.push(error.message))
    await stubStudio(page)
    await gotoAuthenticated(page, '/')
    await openProject(page, 'Elmbrooke, TAK 9355')
    const routeBefore = page.url()

    for (const viewport of REQUIRED_VIEWPORTS) {
      await page.setViewportSize(viewport)
      await expectOperableInViewport(
        page,
        projectPage(page).getByRole('heading', { name: 'Elmbrooke, TAK 9355' }),
      )
      await expectOperableInViewport(
        page,
        projectPage(page).getByLabel('Actions for Beretning_Elmbrooke_8_13.pdf'),
      )
    }
    await emulateBrowserZoom200(page)
    await expectOperableInViewport(
      page,
      projectPage(page).getByLabel('Actions for Beretning_Elmbrooke_8_13.pdf'),
    )
    await page.setViewportSize({ width: 1280, height: 800 })

    const actions = projectPage(page).getByLabel(
      'Actions for Beretning_Elmbrooke_8_13.pdf',
    )
    await activateWithKeyboard(page, actions)
    const downloadEvent = page.waitForEvent('download')
    await activateWithKeyboard(
      page,
      projectPage(page).getByRole('button', {
        name: 'Download Beretning_Elmbrooke_8_13.pdf',
      }),
    )
    const download = await downloadEvent
    expect(download.suggestedFilename()).toBe('Beretning_Elmbrooke_8_13.pdf')
    const bytes = await readFile((await download.path())!)
    expect(bytes.byteLength).toBeGreaterThan(4)
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('%PDF')
    expect(page.url()).toBe(routeBefore)

    await page.route('**/source-representations/*/pdf**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        json: {
          error: {
            code: 'source_artifact_unavailable',
            message: 'internal package C:\\secrets\\artifact.zip is missing',
          },
        },
      }),
    )
    let laterDownloads = 0
    page.on('download', () => {
      laterDownloads += 1
    })
    await activateWithKeyboard(page, actions)
    await activateWithKeyboard(
      page,
      projectPage(page).getByRole('button', {
        name: 'Download Beretning_Elmbrooke_8_13.pdf',
      }),
    )
    const alert = projectPage(page).getByRole('alert')
    await expect(alert).toHaveText(
      'Could not download “Beretning_Elmbrooke_8_13.pdf”.',
    )
    await expect(alert).not.toContainText('artifact.zip')
    await expect.poll(() => laterDownloads).toBe(0)
    expect(page.url()).toBe(routeBefore)
    expect(browserDiagnostics.join('\n')).not.toContain('artifact.zip')
    expect(browserDiagnostics.join('\n')).not.toContain('C:\\secrets')
  })

  test('lists Project Contexts newest first and opens one into the single shell', async ({
    page,
  }) => {
    await stubStudio(page)

    await gotoAuthenticated(page, '/')
    await expect(projectRows(page)).toHaveText([
      /Harrowmere, TAK 9402/,
      /Elmbrooke, TAK 9355/,
    ])
    await expect(
      home(page).getByRole('heading', { name: 'Projects' }),
    ).toBeVisible()

    await openProject(page, 'Elmbrooke, TAK 9355')
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toBeVisible()
    await expect(documentRow(page, 'Fundliste_Elmbrooke.pdf')).toBeVisible()
    await expect(
      projectPage(page).getByRole('heading', { name: 'Elmbrooke, TAK 9355' }),
    ).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(
      home(page).getByRole('heading', { name: 'Projects' }),
    ).toBeVisible()
  })

  test('the row control only discloses, and opening a project is a separate menu action', async ({
    page,
  }) => {
    await stubStudio(page)

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${BERETNING}`)
    await expect(documentRow(page, 'Fundliste_Elmbrooke.pdf')).toBeVisible()

    // The chevron and name are one control: the other Project Context opens
    // without leaving this Source Document, and both branches stay open at
    // once — clicking it never navigates.
    await disclosure(page, 'Harrowmere, TAK 9402').click()
    await expect(documentRow(page, 'Oversigt_Hoersholm.pdf')).toBeVisible()
    await expect(documentRow(page, 'Fundliste_Elmbrooke.pdf')).toBeVisible()
    await expect(page).toHaveURL(
      `/projects/${ELMBROOKE}/documents/${BERETNING}`,
    )

    // Its "•••" menu opens the Project Context page instead, even from the
    // open Source Document of that very Project Context.
    await openProject(page, 'Elmbrooke, TAK 9355')
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
    await expect(
      projectPage(page).getByRole('heading', { name: 'Elmbrooke, TAK 9355' }),
    ).toBeVisible()

    // And its row control collapses it while it stays the routed page.
    await disclosure(page, 'Elmbrooke, TAK 9355').click()
    await expect(documentRow(page, 'Fundliste_Elmbrooke.pdf')).toBeHidden()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
  })

  test('reopens a directly routed Project Context across a refresh', async ({
    page,
  }) => {
    await stubStudio(page)

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}`)
    const project = disclosure(page, 'Elmbrooke, TAK 9355')
    await expect(project).toHaveAttribute('aria-current', 'page')
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
    await expect(project).toHaveAttribute('aria-current', 'page')
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toBeVisible()
  })

  test('deep-links every Project resource tab and the open Batch Extraction', async ({
    page,
  }) => {
    await stubStudio(page)
    const BATCH = '00000000-0000-4000-8000-0000000001b1'
    const batchExtraction = batchExtractionSchema.parse({
      batchExtractionId: BATCH,
      projectContextId: ELMBROOKE,
      schemaRevisionId: '00000000-0000-4000-8000-0000000001b2',
      extractionSchemaId: '00000000-0000-4000-8000-0000000001b3',
      extractionSchemaName: 'Places',
      schemaRevisionNumber: 1,
      strategy: 'ARTICLE',
      executionStatus: 'COMPLETED',
      createdAt: '2026-08-14T10:42:00.000Z',
      members: [
        {
          extractionId: '00000000-0000-4000-8000-0000000001b4',
          sourceDocumentId: BERETNING,
          sourceRepresentationRevisionId: REPRESENTATIONS[BERETNING],
          executionStatus: 'COMPLETED',
          reviewable: false,
          completed: true,
          currentReview: null,
        },
      ],
    })
    // The resource tabs read past the persisted Project Context reads that
    // `stubStudio` composes, so each answers its own empty or seeded list.
    await page.route('**/api/extraction-schemas**', (route) =>
      route.fulfill({ json: { extractionSchemas: [] } }),
    )
    await page.route('**/api/batch-schema-suggestions**', (route) =>
      route.fulfill({ json: { batchSchemaSuggestions: [] } }),
    )
    await page.route('**/api/schema-revisions/**', (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'No Schema Revision.' } } }),
    )
    await page.route('**/api/batch-extractions**', (route) =>
      route.fulfill({ json: { batchExtractions: [batchExtraction] } }),
    )

    // A deep link opens the tab it names, and a refresh keeps it.
    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/schemas`)
    const tab = (name: string) =>
      projectPage(page).getByRole('tab', { name, exact: true })
    await expect(tab('Schemas')).toHaveAttribute('aria-selected', 'true')
    await expect(projectPage(page).getByRole('heading', { name: 'Build your schema from a document' })).toBeVisible()
    await page.reload()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}/schemas`)
    await expect(tab('Schemas')).toHaveAttribute('aria-selected', 'true')

    // Sources is the page's entry, so it keeps the bare Project Context path.
    await tab('Sources').click()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
    await tab('Extractions').click()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}/extractions`)

    // The opened Batch Extraction is routed too, so it is linkable on its own.
    await projectPage(page).getByText('Places · Schema Revision 1').click()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}/extractions/${BATCH}`)
    const members = projectPage(page).getByRole('list', {
      name: 'Batch Extraction members',
    })
    await expect(members).toBeVisible()
    await page.reload()
    await expect(members).toBeVisible()

    // Back undoes each step it took to get here, tab switches included.
    await page.goBack()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}/extractions`)
    await expect(members).toBeHidden()
    await page.goBack()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
    await expect(tab('Sources')).toHaveAttribute('aria-selected', 'true')
    await page.goBack()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}/schemas`)
    await expect(tab('Schemas')).toHaveAttribute('aria-selected', 'true')

    // Sources' path is the bare one, so no other segment is routable.
    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/sources`)
    await expect(
      page.getByRole('heading', {
        name: 'That project reference is invalid',
      }),
    ).toBeVisible()
  })

  test('back and forward walk Source Documents as well as Project Contexts', async ({
    page,
  }) => {
    await stubStudio(page)
    const beretning = `/projects/${ELMBROOKE}/documents/${BERETNING}`
    const fundliste = `/projects/${ELMBROOKE}/documents/${FUNDLISTE}`

    await gotoAuthenticated(page, '/')
    await openProject(page, 'Elmbrooke, TAK 9355')
    await documentRow(page, 'Beretning_Elmbrooke_8_13.pdf').click()
    await expect(page).toHaveURL(beretning)
    await documentRow(page, 'Fundliste_Elmbrooke.pdf').click()
    await expect(page).toHaveURL(fundliste)
    await expect(documentRow(page, 'Fundliste_Elmbrooke.pdf')).toHaveAttribute(
      'aria-current',
      'page',
    )

    await page.goBack()
    await expect(page).toHaveURL(beretning)
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    await expect(page).toHaveURL(`/projects/${ELMBROOKE}`)
    await expect(
      projectPage(page).getByRole('heading', { name: 'Elmbrooke, TAK 9355' }),
    ).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL('/')

    await page.goForward()
    await page.goForward()
    await expect(page).toHaveURL(beretning)
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('a superseded reopen is aborted and never paints over the winning route', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${BERETNING}`)
    await expect(
      page.getByRole('tab', { name: /Beretning_Elmbrooke_8_13\.pdf/ }),
    ).toBeVisible()

    // Hold the next Source Document so the switch can be superseded mid-read.
    const release = studio.hold(`${FUNDLISTE}/reopen`)
    await documentRow(page, 'Fundliste_Elmbrooke.pdf').click()
    // The previous Source Document stays readable-in-place under the overlay.
    const opening = page.getByRole('status', {
      name: 'Opening Source Document',
    })
    await expect(opening).toBeVisible()
    await expect(
      page.getByRole('tab', { name: /Beretning_Elmbrooke_8_13\.pdf/ }),
    ).toBeVisible()

    await openProject(page, 'Harrowmere, TAK 9402')
    release()

    await expect(page).toHaveURL(`/projects/${HORSHOLM}`)
    await expect(
      projectPage(page).getByRole('heading', { name: 'Harrowmere, TAK 9402' }),
    ).toBeVisible()
    await expect(opening).toBeHidden()
    expect(studio.cancelled).toContain(
      `/api/project-contexts/${ELMBROOKE}/source-documents/${FUNDLISTE}/reopen`,
    )
  })
})

test.describe('reopening a routed Source Document', () => {
  test('reopens the durable snapshot on refresh, pinned to one representation', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${BERETNING}`)
    await expect(
      page.getByRole('tab', { name: /Beretning_Elmbrooke_8_13\.pdf/ }),
    ).toBeVisible()
    await expect(page.getByText('/ 6', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Indexing document…')).toBeHidden()
    await expect(page.getByText('Indexing failed')).toBeHidden()
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')

    // Every resource the snapshot offers is pinned to the reopened revision;
    // the version query only busts caches across representation revisions.
    const resource = (artifact: string) =>
      new RegExp(
        `^/api/project-contexts/${ELMBROOKE}/source-representations/${DEMO_REPRESENTATION_ID}/${artifact}\\?v=`,
      )
    const resources = Object.values(
      studio.snapshots[0].sourceRepresentation.resources,
    )
    expect(resources[0]).toMatch(resource('pdf'))
    expect(resources[1]).toMatch(resource('markdown'))
    expect(resources[2]).toMatch(resource('source'))
    // And the two the workspace reads came from that revision, same-origin.
    // Recorded paths carry no query, so they match the bare resource path.
    expect(studio.requests).toContain(
      `/api/project-contexts/${ELMBROOKE}/source-representations/${DEMO_REPRESENTATION_ID}/pdf`,
    )
    expect(studio.requests).toContain(
      `/api/project-contexts/${ELMBROOKE}/source-representations/${DEMO_REPRESENTATION_ID}/markdown`,
    )

    await page.reload()
    await expect(page.getByText('/ 6', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      documentRow(page, 'Beretning_Elmbrooke_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')
  })

})

test.describe('bad references and bounded failures', () => {
  test('renders a malformed route identity without asking the server about it', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await gotoAuthenticated(page, '/projects/NOT-A-UUID')
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That project reference is invalid',
      }),
    ).toBeVisible()
    // The rail stays usable, so the researcher is never stranded.
    await expect(projectRows(page)).toHaveCount(2)

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/xyz`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That project reference is invalid',
      }),
    ).toBeVisible()

    expect(
      studio.requests.filter(
        (path) => path.includes('NOT-A-UUID') || path.includes('xyz'),
      ),
    ).toEqual([])
  })

  test('authenticates before parsing invalid API parameters', async ({
    request,
  }) => {
    const invalid = [
      `/api/project-contexts/NOT-A-UUID`,
      `/api/project-contexts?limit=999`,
      `/api/project-contexts/${ELMBROOKE}/source-documents/xyz/reopen`,
      `/api/project-contexts/${ELMBROOKE}/source-representations/xyz/pdf`,
    ]

    for (const path of invalid) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(401)
      expect(response.headers()['cache-control'], path).toBe('no-store')
      const body = await response.json()
      expect(Object.keys(body), path).toEqual(['error'])
      expect(Object.keys(body.error).sort(), path).toEqual(['code', 'message'])
      expect(body.error.code, path).toBe('authentication_required')
      expect(body.error.message, path).toMatch(/\S/)
    }
  })

  test('explains a Source Document the routed Project Context does not contain', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${OVERSIGT}`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Source Document is not in this project',
      }),
    ).toBeVisible()
    // Containment is settled by the branch read; no snapshot is ever requested.
    expect(studio.requests).not.toContain(
      `/api/project-contexts/${ELMBROOKE}/source-documents/${OVERSIGT}/reopen`,
    )

    await openProject(page, 'Harrowmere, TAK 9402')
    await expect(page).toHaveURL(`/projects/${HORSHOLM}`)
    await expect(documentRow(page, 'Oversigt_Hoersholm.pdf')).toBeVisible()
  })

  test('explains a Project Context that no longer exists and keeps recents', async ({
    page,
  }) => {
    await stubStudio(page, {
      store: railStore({
        async getProjectContextWithDocuments() {
          return null
        },
      }),
    })

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}`)
    await expect(
      projectPage(page).getByRole('heading', {
        name: 'That project no longer exists',
      }),
    ).toBeVisible()
    await expect(projectRows(page)).toHaveCount(2)
  })

  test('explains a contained Source Document with no durable snapshot', async ({
    page,
  }) => {
    await stubStudio(page, {
      store: railStore({
        async getDocumentReopenSnapshot() {
          return null
        },
      }),
    })

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${BERETNING}`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Source Document cannot be reopened',
      }),
    ).toBeVisible()
    // A missing snapshot stays missing however often it is read again.
    await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden()
  })

  test('bounds a persistence failure and retries the same route', async ({
    page,
  }) => {
    const internal = 'pg://free:hunter2@db.internal:5432/free'
    let unavailable = true
    await stubStudio(page, {
      store: railStore({
        async getDocumentReopenSnapshot(projectContextId, sourceDocumentId) {
          if (unavailable) throw new Error(`connection refused: ${internal}`)
          return base.getDocumentReopenSnapshot(
            projectContextId,
            sourceDocumentId,
          )
        },
      }),
    })

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${BERETNING}`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Source Document could not be opened',
      }),
    ).toBeVisible()
    await expect(
      page.getByText('Project Context storage is unavailable.'),
    ).toBeVisible()
    expect(await page.content()).not.toContain(internal)

    unavailable = false
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(
      page.getByRole('tab', { name: /Beretning_Elmbrooke_8_13\.pdf/ }),
    ).toBeVisible()
  })

  test('bounds an unavailable retained artifact and offers a retry', async ({
    page,
  }) => {
    await stubStudio(page, { artifacts: 'unavailable' })

    await gotoAuthenticated(page, `/projects/${ELMBROOKE}/documents/${BERETNING}`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Source Document could not be opened',
      }),
    ).toBeVisible()
    await expect(
      page.getByText('The retained Source Document artifact is unavailable.'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  })
})
