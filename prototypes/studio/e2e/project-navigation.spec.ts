import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type {
  DocumentReopenSnapshot,
  ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import {
  DEMO_DOCUMENT_ID,
  DEMO_PROJECT_ID,
  DEMO_REPRESENTATION_ID,
} from '../api/project_contexts.fixture.js'

const sourcePdf = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
)
const parsedDocument = await readFile(
  fileURLToPath(
    new URL('../src/assets/parsed_document.v2.json', import.meta.url),
  ),
  'utf8',
)

const ELLEKILDE = DEMO_PROJECT_ID
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
    name: 'Hørsholm, TAK 1402',
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
    projectContextId: ELLEKILDE,
    name: 'Ellekilde, TAK 1355',
    createdAt: '2026-07-31T12:00:00.000Z',
    sourceDocuments: [
      {
        sourceDocumentId: BERETNING,
        name: 'Beretning_Ellekilde_8_13.pdf',
        createdAt: '2026-07-31T12:01:00.000Z',
        pageCount: 6,
      },
      {
        sourceDocumentId: FUNDLISTE,
        name: 'Fundliste_Ellekilde.pdf',
        createdAt: '2026-07-31T12:02:00.000Z',
        pageCount: 2,
      },
    ],
  },
]

/** The durable research state a reopened Source Document must bring back. */
const DURABLE = {
  annotationSet: {
    annotationSetId: '00000000-0000-4000-8000-0000000000c1',
    revisionNumber: 3,
    snapshot: [
      {
        annotationId: '00000000-0000-4000-8000-0000000000d1',
        evidenceAnchorId: 'anchor-grav-8',
        text: 'Grav 8 laa i undergrunden',
        pageNumber: 2,
      },
    ],
  },
  extractionSchema: {
    extractionSchemaId: '00000000-0000-4000-8000-0000000000e1',
    schemaRevisionId: '00000000-0000-4000-8000-0000000000e2',
    revisionNumber: 4,
    schemaTree: {
      recordDescription: 'One place record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    },
  },
  latestAttempt: {
    extractionId: '00000000-0000-4000-8000-0000000000f1',
    sourceDocumentId: BERETNING,
    sourceRepresentationRevisionId: DEMO_REPRESENTATION_ID,
    sourceRepresentationRevisionNumber: 2,
    schemaRevisionId: '00000000-0000-4000-8000-0000000000e2',
    extractionSchemaId: '00000000-0000-4000-8000-0000000000e1',
    schemaRevisionNumber: 4,
    schemaTree: {
      recordDescription: 'One place record.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
    },
    strategy: 'ARTICLE',
    outcome: 'SUCCEEDED',
    complete: true,
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    diagnostics: {
      phase: 'grounding',
      durationMs: 1,
      modelCalls: 0,
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      values: null,
      grounding: null,
      catalog: null,
    },
    failure: null,
    resultPayload: { place: 'Ellekilde' },
    evidenceLinks: [],
    reviewable: true,
    retryOfId: null,
    batchExtractionId: null,
    createdAt: new Date('2026-08-02T10:00:00.000Z'),
    reviewedAt: null,
    reviewDecisions: [],
  },
  latestReviewed: null,
} satisfies Pick<
  DocumentReopenSnapshot,
  'annotationSet' | 'extractionSchema' | 'latestAttempt' | 'latestReviewed'
>

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
  ProjectStore,
  | 'listProjectContexts'
  | 'getProjectContextWithDocuments'
  | 'getDocumentReopenSnapshot'
>

const base: NavigationStore = {
  async listProjectContexts(limit) {
    return SEED.slice(0, limit).map(summary)
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
      sourceDocument: document,
      sourceRepresentation: {
        sourceRepresentationId: REPRESENTATIONS[sourceDocumentId],
        revisionNumber: 2,
        createdAt: document.createdAt,
      },
      annotationSet: null,
      extractionSchema: null,
      latestAttempt: null,
      latestReviewed: null,
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
}

/**
 * The persisted reads Studio would serve from PostgreSQL, composed by the real
 * handlers so the browser reads the shipped contract — DTOs, status codes and
 * bounded failures alike. Only the retained artifacts are served directly,
 * standing in for the Parsing Service.
 */
async function stubStudio(
  page: Page,
  options: { store?: NavigationStore; artifacts?: 'unavailable' } = {},
): Promise<Studio> {
  const store = options.store ?? railStore()
  const projectContexts = createGetProjectContexts(store)
  const reopen = createGetDocumentReopen(store)
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

  await page.route('**/api/source-representations/**', async (route) => {
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
      body: '# Beretning\n\nGrav 8',
      contentType: 'text/markdown; charset=utf-8',
      headers: immutable,
    })
  })

  return {
    requests,
    cancelled,
    snapshots,
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
  page.getByRole('navigation', { name: 'Project Contexts' })
const workspace = (page: Page) =>
  page.getByRole('region', { name: 'Source Document' })
/** The management page for the routed Project Context. */
const projectPage = (page: Page) =>
  page.getByRole('region', { name: 'Project Context' })
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
  test('returns focus to the delete control when cancellation closes the dialog', async ({
    page,
  }) => {
    await stubStudio(page)
    await page.goto('/')
    await openProject(page, 'Hørsholm, TAK 1402')

    const remove = projectPage(page).getByRole('button', { name: 'Delete' })
    await remove.click()
    const dialog = page.getByRole('dialog', { name: 'Delete Project Context' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await expect(dialog).not.toBeVisible()
    await expect(remove).toBeFocused()
  })

  test('returns focus to create and rename controls when name editing is cancelled', async ({
    page,
  }) => {
    await stubStudio(page)
    await page.goto('/')

    const create = page.getByRole('button', { name: '+ New project' })
    await create.click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(create).toBeFocused()

    await openProject(page, 'Hørsholm, TAK 1402')
    const rename = projectPage(page).getByRole('button', { name: 'Rename' })
    await rename.click()
    await page
      .getByRole('textbox', { name: 'Project Context name' })
      .press('Escape')
    await expect(rename).toBeFocused()
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
    await page.goto('/')

    await page.getByRole('button', { name: '+ New project' }).click()
    await page
      .getByRole('textbox', { name: 'Project name' })
      .fill('Created project')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(
      page.getByRole('button', { name: '+ New project' }),
    ).toBeFocused()

    await openProject(page, 'Hørsholm, TAK 1402')
    await projectPage(page).getByRole('button', { name: 'Rename' }).click()
    const rename = page.getByRole('textbox', { name: 'Project Context name' })
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
      page.getByRole('button', { name: 'Collapse Project Contexts' }),
    ).toBeFocused()
  })

  test('lists Project Contexts newest first and opens one into the single shell', async ({
    page,
  }) => {
    await stubStudio(page)

    await page.goto('/')
    await expect(projectRows(page)).toHaveText([
      /Hørsholm, TAK 1402/,
      /Ellekilde, TAK 1355/,
    ])
    await expect(
      workspace(page).getByRole('heading', { name: 'No project open' }),
    ).toBeVisible()

    await openProject(page, 'Ellekilde, TAK 1355')
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toBeVisible()
    await expect(documentRow(page, 'Fundliste_Ellekilde.pdf')).toBeVisible()
    await expect(
      projectPage(page).getByRole('heading', { name: 'Ellekilde, TAK 1355' }),
    ).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(
      workspace(page).getByRole('heading', { name: 'No project open' }),
    ).toBeVisible()
  })

  test('the row control only discloses, and opening a project is a separate menu action', async ({
    page,
  }) => {
    await stubStudio(page)

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
    await expect(documentRow(page, 'Fundliste_Ellekilde.pdf')).toBeVisible()

    // The chevron and name are one control: the other Project Context opens
    // without leaving this Source Document, and both branches stay open at
    // once — clicking it never navigates.
    await disclosure(page, 'Hørsholm, TAK 1402').click()
    await expect(documentRow(page, 'Oversigt_Hoersholm.pdf')).toBeVisible()
    await expect(documentRow(page, 'Fundliste_Ellekilde.pdf')).toBeVisible()
    await expect(page).toHaveURL(
      `/projects/${ELLEKILDE}/documents/${BERETNING}`,
    )

    // Its "•••" menu opens the Project Context page instead, even from the
    // open Source Document of that very Project Context.
    await openProject(page, 'Ellekilde, TAK 1355')
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
    await expect(
      projectPage(page).getByRole('heading', { name: 'Ellekilde, TAK 1355' }),
    ).toBeVisible()

    // And its row control collapses it while it stays the routed page.
    await disclosure(page, 'Ellekilde, TAK 1355').click()
    await expect(documentRow(page, 'Fundliste_Ellekilde.pdf')).toBeHidden()
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
  })

  test('reopens a directly routed Project Context across a refresh', async ({
    page,
  }) => {
    await stubStudio(page)

    await page.goto(`/projects/${ELLEKILDE}`)
    const project = disclosure(page, 'Ellekilde, TAK 1355')
    await expect(project).toHaveAttribute('aria-current', 'page')
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
    await expect(project).toHaveAttribute('aria-current', 'page')
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toBeVisible()
  })

  test('back and forward walk Source Documents as well as Project Contexts', async ({
    page,
  }) => {
    await stubStudio(page)
    const beretning = `/projects/${ELLEKILDE}/documents/${BERETNING}`
    const fundliste = `/projects/${ELLEKILDE}/documents/${FUNDLISTE}`

    await page.goto('/')
    await openProject(page, 'Ellekilde, TAK 1355')
    await documentRow(page, 'Beretning_Ellekilde_8_13.pdf').click()
    await expect(page).toHaveURL(beretning)
    await documentRow(page, 'Fundliste_Ellekilde.pdf').click()
    await expect(page).toHaveURL(fundliste)
    await expect(documentRow(page, 'Fundliste_Ellekilde.pdf')).toHaveAttribute(
      'aria-current',
      'page',
    )

    await page.goBack()
    await expect(page).toHaveURL(beretning)
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')
    await page.goBack()
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
    await expect(
      projectPage(page).getByRole('heading', { name: 'Ellekilde, TAK 1355' }),
    ).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL('/')

    await page.goForward()
    await page.goForward()
    await expect(page).toHaveURL(beretning)
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('a superseded reopen is aborted and never paints over the winning route', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
    await expect(
      workspace(page).getByText('Beretning_Ellekilde_8_13.pdf').first(),
    ).toBeVisible()

    // Hold the next Source Document so the switch can be superseded mid-read.
    const release = studio.hold(`${FUNDLISTE}/reopen`)
    await documentRow(page, 'Fundliste_Ellekilde.pdf').click()
    // The previous Source Document stays readable-in-place under the overlay.
    await expect(page.getByText('Opening Source Document…')).toBeVisible()
    await expect(
      workspace(page).getByText('Beretning_Ellekilde_8_13.pdf').first(),
    ).toBeVisible()

    await openProject(page, 'Hørsholm, TAK 1402')
    release()

    await expect(page).toHaveURL(`/projects/${HORSHOLM}`)
    await expect(
      projectPage(page).getByRole('heading', { name: 'Hørsholm, TAK 1402' }),
    ).toBeVisible()
    await expect(page.getByText('Opening Source Document…')).toBeHidden()
    expect(studio.cancelled).toContain(
      `/api/project-contexts/${ELLEKILDE}/source-documents/${FUNDLISTE}/reopen`,
    )
  })
})

test.describe('reopening a routed Source Document', () => {
  test('reopens the durable snapshot on refresh, pinned to one representation', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
    await expect(
      workspace(page).getByText('Beretning_Ellekilde_8_13.pdf').first(),
    ).toBeVisible()
    await expect(page.getByText(/pages · text highlights only/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Indexing document…')).toBeHidden()
    await expect(page.getByText('Indexing failed')).toBeHidden()
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')

    // Every resource the snapshot offers is pinned to the reopened revision;
    // the version query only busts caches across representation revisions.
    const resource = (artifact: string) =>
      new RegExp(
        `^/api/source-representations/${DEMO_REPRESENTATION_ID}/${artifact}\\?v=`,
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
      `/api/source-representations/${DEMO_REPRESENTATION_ID}/pdf`,
    )
    expect(studio.requests).toContain(
      `/api/source-representations/${DEMO_REPRESENTATION_ID}/markdown`,
    )

    await page.reload()
    await expect(page.getByText(/pages · text highlights only/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      documentRow(page, 'Beretning_Ellekilde_8_13.pdf'),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('reopens durable research state and restores no presentation state', async ({
    page,
  }) => {
    await stubStudio(page, {
      store: railStore({
        async getDocumentReopenSnapshot(projectContextId, sourceDocumentId) {
          const snapshot = await base.getDocumentReopenSnapshot(
            projectContextId,
            sourceDocumentId,
          )
          return snapshot && sourceDocumentId === BERETNING
            ? { ...snapshot, ...DURABLE }
            : snapshot
        },
      }),
    })

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
    // The Annotation tab was retired in favor of SchemaPanel's own doc chat —
    // this locator and its visibility checks are commented out, not deleted.
    // const annotation = page.getByRole('tab', { name: 'Annot. 1' })
    const schemaTab = page.getByRole('tab', { name: /^Schema\s*1$/ })
    const rerun = page.getByRole('button', { name: '↻ Re-run extraction' })
    // await expect(annotation).toBeVisible()
    await expect(schemaTab).toBeVisible()
    await expect(rerun).toBeVisible()
    await expect(page.getByText(/pages · text highlights only/)).toBeVisible({
      timeout: 20_000,
    })

    // Presentation state a researcher changes by hand.
    const separator = page.getByRole('separator', {
      name: 'Resize Project Context rail',
    })
    await separator.focus()
    await separator.press('ArrowRight')
    await expect(separator).toHaveAttribute('aria-valuenow', '222')
    await page
      .getByRole('button', { name: 'Collapse Project Contexts' })
      .click()
    await expect(
      page.getByRole('button', { name: 'Expand Project Contexts' }),
    ).toBeVisible()
    const rightRail = page.getByLabel('Evidence, schema and results')
    await schemaTab.click()
    await page.getByRole('button', { name: 'JSON' }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    const draft = rightRail.locator('textarea')
    await draft.fill('{ "unsaved": "draft" }')
    await expect(draft).toHaveValue('{ "unsaved": "draft" }')
    const pdf = page.locator('.pdf-viewer')
    await pdf.evaluate((element) => element.scrollTo(0, 900))
    await expect
      .poll(() => pdf.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)

    // Navigate off the Schema tab so reload's reset-to-default is provable
    // below (the default tab is Schema, same as the tab just edited above).
    await page.getByRole('tab', { name: /^Evidence/ }).click()

    await page.reload()

    // Durable: the Annotation Set (persisted, no longer surfaced in the UI),
    // Extraction Schema, and compatible Extraction.
    await expect(schemaTab).toBeVisible()
    await expect(rerun).toBeVisible()
    // Ephemeral: rail width and expansion, the right rail tab, the unsaved
    // Extraction Schema draft, and PDF position.
    await expect(separator).toHaveAttribute('aria-valuenow', '212')
    await expect(
      page.getByRole('button', { name: 'Collapse Project Contexts' }),
    ).toBeVisible()
    await expect(schemaTab).toHaveAttribute('aria-selected', 'true')
    await schemaTab.click()
    await expect(rightRail.locator('textarea')).not.toHaveValue(
      '{ "unsaved": "draft" }',
    )
    await expect(page.getByText(/pages · text highlights only/)).toBeVisible({
      timeout: 20_000,
    })
    expect(await pdf.evaluate((element) => element.scrollTop)).toBe(0)
  })
})

test.describe('bad references and bounded failures', () => {
  test('renders a malformed route identity without asking the server about it', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await page.goto('/projects/NOT-A-UUID')
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Project Context reference is invalid',
      }),
    ).toBeVisible()
    // The rail stays usable, so the researcher is never stranded.
    await expect(projectRows(page)).toHaveCount(2)

    await page.goto(`/projects/${ELLEKILDE}/documents/xyz`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Project Context reference is invalid',
      }),
    ).toBeVisible()

    expect(
      studio.requests.filter(
        (path) => path.includes('NOT-A-UUID') || path.includes('xyz'),
      ),
    ).toEqual([])
  })

  test('answers invalid API parameters with a bounded 422 and no internals', async ({
    request,
  }) => {
    const invalid = [
      `/api/project-contexts/NOT-A-UUID`,
      `/api/project-contexts?limit=999`,
      `/api/project-contexts/${ELLEKILDE}/source-documents/xyz/reopen`,
      `/api/source-representations/xyz/pdf`,
    ]

    for (const path of invalid) {
      const response = await request.get(path)
      expect(response.status(), path).toBe(422)
      expect(response.headers()['cache-control'], path).toBe('no-store')
      const body = await response.json()
      expect(Object.keys(body), path).toEqual(['error'])
      // Code and message only: no details, cause, stack, or query text.
      expect(Object.keys(body.error).sort(), path).toEqual(['code', 'message'])
      expect(body.error.code, path).toBe('invalid_request')
      expect(body.error.message, path).toMatch(/\S/)
    }
  })

  test('explains a Source Document the routed Project Context does not contain', async ({
    page,
  }) => {
    const studio = await stubStudio(page)

    await page.goto(`/projects/${ELLEKILDE}/documents/${OVERSIGT}`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Source Document is not in this Project Context',
      }),
    ).toBeVisible()
    // Containment is settled by the branch read; no snapshot is ever requested.
    expect(studio.requests).not.toContain(
      `/api/project-contexts/${ELLEKILDE}/source-documents/${OVERSIGT}/reopen`,
    )

    await openProject(page, 'Hørsholm, TAK 1402')
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

    await page.goto(`/projects/${ELLEKILDE}`)
    await expect(
      projectPage(page).getByRole('heading', {
        name: 'That Project Context no longer exists',
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

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
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

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
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
      workspace(page).getByText('Beretning_Ellekilde_8_13.pdf').first(),
    ).toBeVisible()
  })

  test('bounds an unavailable retained artifact and offers a retry', async ({
    page,
  }) => {
    await stubStudio(page, { artifacts: 'unavailable' })

    await page.goto(`/projects/${ELLEKILDE}/documents/${BERETNING}`)
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

test.describe('SCRATCH tab bar verification (temporary, to be removed)', () => {
  test('tab accumulation and schema persistence', async ({ page }) => {
    page.on('console', (msg) => console.log('BROWSER', msg.type(), msg.text()))
    page.on('pageerror', (err) => console.log('PAGEERROR', err.message, err.stack))
    page.on('response', (res) => {
      if (res.url().includes('/reopen')) {
        console.log('REOPEN RESPONSE', res.status(), res.url())
        res.text().then((t) => console.log('REOPEN BODY', t)).catch(() => {})
      }
    })
    await stubStudio(page)

    await page.goto('/')
    await disclosure(page, 'Ellekilde, TAK 1355').click()

    const tabStrip = page.getByRole('tablist', { name: 'Open Source Documents' })

    const settled = () => expect(page.getByText('Opening Source Document…')).toBeHidden()

    // A single click opens the Source Document as a tab.
    await documentRow(page, 'Beretning_Ellekilde_8_13.pdf').click()
    await settled()
    const beretningTab = tabStrip.getByRole('tab', {
      name: 'Beretning_Ellekilde_8_13.pdf',
    })
    await expect(beretningTab).toBeVisible()
    await expect(tabStrip.getByRole('tab')).toHaveCount(1)

    // A single click on a different document ADDS a second tab.
    await documentRow(page, 'Fundliste_Ellekilde.pdf').click()
    await settled()
    const fundlisteTab = tabStrip.getByRole('tab', {
      name: 'Fundliste_Ellekilde.pdf',
    })
    await expect(fundlisteTab).toBeVisible()
    await expect(tabStrip.getByRole('tab')).toHaveCount(2)
    await expect(beretningTab).toBeVisible()

    // Reactivate Beretning via its tab.
    await beretningTab.click()
    await settled()

    // Breadcrumb reflects the active tab.
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Ellekilde, TAK 1355',
    )
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Beretning_Ellekilde_8_13.pdf',
    )

    await expect(page.getByText('Opening Source Document…')).toBeHidden()
    console.log('DEBUG tabs', await page.getByRole('tab').allTextContents())
    await page.screenshot({ path: 'test-results/scratch-debug.png', fullPage: true })

    // Generate a schema against the active (Beretning) document, then switch
    // tabs within the same project — the Schema panel must NOT reset.
    const schemaTab = page.getByRole('tab', { name: /^Schema/ })
    await schemaTab.click()
    await page.getByPlaceholder(/what should the schema capture/i).fill('Capture the grave number')
    await page.getByRole('button', { name: /generate schema/i }).click()
    await expect(page.getByText(/Record$/)).toBeVisible({ timeout: 20_000 })

    await fundlisteTab.click()
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Fundliste_Ellekilde.pdf',
    )
    // Same schema still visible after switching documents within the project.
    await expect(page.getByText(/Record$/)).toBeVisible()

    // Closing the active tab re-activates the previously active tab.
    await page.getByRole('button', { name: 'Close Fundliste_Ellekilde.pdf' }).click()
    await expect(tabStrip.getByRole('tab')).toHaveCount(1)
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Beretning_Ellekilde_8_13.pdf',
    )
  })
})
