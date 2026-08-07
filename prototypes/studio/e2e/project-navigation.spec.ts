import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type {
  DocumentReopenSnapshot,
  ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import {
  DEMO_ARTIFACT_REFERENCE,
  DEMO_DOCUMENT_ID,
  DEMO_PROJECT_ID,
  DEMO_REPRESENTATION_ID,
} from '../api/project_contexts.fixture.js'

const sourcePdf = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
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
      },
      {
        sourceDocumentId: FUNDLISTE,
        name: 'Fundliste_Ellekilde.pdf',
        createdAt: '2026-07-31T12:02:00.000Z',
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
    revisionNumber: 4,
    schemaTree: { place: 'string' },
  },
  extraction: {
    extractionId: '00000000-0000-4000-8000-0000000000f1',
    createdAt: new Date('2026-08-01T08:00:00.000Z'),
    outcome: 'SUCCEEDED' as const,
    resultPayload: { result: { place: 'Ellekilde' }, evidence: null },
    failure: null,
    reviewDecisions: [],
  },
} satisfies Pick<
  DocumentReopenSnapshot,
  'annotationSet' | 'extractionSchema' | 'extraction'
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

const base: ProjectStore = {
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
      extraction: null,
    }
  },
  async getSourceRepresentation(sourceRepresentationId) {
    return Object.values(REPRESENTATIONS).includes(sourceRepresentationId)
      ? {
          artifactReference: DEMO_ARTIFACT_REFERENCE,
          artifactSha256: 'c'.repeat(64),
        }
      : null
  },
  async persistReviewedExtraction() {
    return null
  },
}

const railStore = (overrides: Partial<ProjectStore> = {}): ProjectStore => ({
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
  options: { store?: ProjectStore; artifacts?: 'unavailable' } = {},
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
    const immutable = { 'cache-control': 'private, max-age=31536000, immutable' }
    if (pathname.endsWith('/pdf'))
      return settle({
        path: sourcePdf,
        contentType: 'application/pdf',
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
const documentRow = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true })

test.describe('rail navigation', () => {
  test('lists Project Contexts newest first and opens one into the single shell', async ({
    page,
  }) => {
    await stubStudio(page)

    await page.goto('/')
    await expect(rail(page).getByRole('button', { name: /TAK/ })).toHaveText([
      /Hørsholm, TAK 1402/,
      /Ellekilde, TAK 1355/,
    ])
    await expect(
      workspace(page).getByRole('heading', { name: 'No Project Context open' }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Ellekilde, TAK 1355' }).click()
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
    await expect(documentRow(page, 'Beretning_Ellekilde_8_13.pdf')).toBeVisible()
    await expect(documentRow(page, 'Fundliste_Ellekilde.pdf')).toBeVisible()
    await expect(
      workspace(page).getByRole('heading', { name: 'No Source Document open' }),
    ).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(
      workspace(page).getByRole('heading', { name: 'No Project Context open' }),
    ).toBeVisible()
  })

  test('reopens a directly routed Project Context across a refresh', async ({
    page,
  }) => {
    await stubStudio(page)

    await page.goto(`/projects/${ELLEKILDE}`)
    const project = page.getByRole('button', { name: 'Ellekilde, TAK 1355' })
    await expect(project).toHaveAttribute('aria-current', 'page')
    await expect(project).toHaveAttribute('aria-expanded', 'true')
    await expect(documentRow(page, 'Beretning_Ellekilde_8_13.pdf')).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(`/projects/${ELLEKILDE}`)
    await expect(project).toHaveAttribute('aria-current', 'page')
    await expect(documentRow(page, 'Beretning_Ellekilde_8_13.pdf')).toBeVisible()
  })

  test('back and forward walk Source Documents as well as Project Contexts', async ({
    page,
  }) => {
    await stubStudio(page)
    const beretning = `/projects/${ELLEKILDE}/documents/${BERETNING}`
    const fundliste = `/projects/${ELLEKILDE}/documents/${FUNDLISTE}`

    await page.goto('/')
    await page.getByRole('button', { name: 'Ellekilde, TAK 1355' }).click()
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
      workspace(page).getByRole('heading', { name: 'No Source Document open' }),
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

    await page.getByRole('button', { name: 'Hørsholm, TAK 1402' }).click()
    release()

    await expect(page).toHaveURL(`/projects/${HORSHOLM}`)
    await expect(
      workspace(page).getByRole('heading', { name: 'No Source Document open' }),
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

    // Every resource the snapshot offers is pinned to the reopened revision.
    expect(Object.values(studio.snapshots[0].sourceRepresentation.resources)).toEqual([
      `/api/source-representations/${DEMO_REPRESENTATION_ID}/pdf`,
      `/api/source-representations/${DEMO_REPRESENTATION_ID}/markdown`,
      `/api/source-representations/${DEMO_REPRESENTATION_ID}/parsed-document`,
    ])
    // And the two the workspace reads came from that revision, same-origin.
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
    const annotation = page.getByRole('button', {
      name: 'Remove highlight: Grav 8 laa i undergrunden',
    })
    const schemaTab = page.getByRole('tab', { name: /^Schema\s*1$/ })
    const rerun = page.getByRole('button', { name: '↻ Re-run extraction' })
    await expect(annotation).toBeVisible()
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
    await page.getByRole('button', { name: 'Collapse Project Contexts' }).click()
    await expect(
      page.getByRole('button', { name: 'Expand Project Contexts' }),
    ).toBeVisible()
    const rightRail = page.getByLabel('Annotations, chat and schema')
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

    await page.reload()

    // Durable: the Annotation Set, Extraction Schema, and compatible Extraction.
    await expect(annotation).toBeVisible()
    await expect(schemaTab).toBeVisible()
    await expect(rerun).toBeVisible()
    // Ephemeral: rail width and expansion, the right rail tab, the unsaved
    // Extraction Schema draft, and PDF position.
    await expect(separator).toHaveAttribute('aria-valuenow', '212')
    await expect(
      page.getByRole('button', { name: 'Collapse Project Contexts' }),
    ).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Annot\./ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await schemaTab.click()
    await expect(rightRail.locator('textarea')).toHaveCount(0)
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
    await expect(rail(page).getByRole('button', { name: /TAK/ })).toHaveCount(2)

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

    await page.getByRole('button', { name: 'Hørsholm, TAK 1402' }).click()
    await expect(page).toHaveURL(`/projects/${HORSHOLM}`)
    await expect(documentRow(page, 'Oversigt_Hoersholm.pdf')).toBeVisible()
  })

  test('explains a Project Context that no longer exists and keeps recents', async ({
    page,
  }) => {
    await stubStudio(page, {
      store: railStore({ async getProjectContextWithDocuments() {
        return null
      } }),
    })

    await page.goto(`/projects/${ELLEKILDE}`)
    await expect(
      workspace(page).getByRole('heading', {
        name: 'That Project Context no longer exists',
      }),
    ).toBeVisible()
    await expect(rail(page).getByRole('button', { name: /TAK/ })).toHaveCount(2)
  })

  test('explains a contained Source Document with no durable snapshot', async ({
    page,
  }) => {
    await stubStudio(page, {
      store: railStore({ async getDocumentReopenSnapshot() {
        return null
      } }),
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
          return base.getDocumentReopenSnapshot(projectContextId, sourceDocumentId)
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
