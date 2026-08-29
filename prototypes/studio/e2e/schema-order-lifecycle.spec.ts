import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { DEVELOPMENT_ENTRA_TENANT_ID } from '../server/entraIdentityProvider.js'
import { loginResearcher } from './auth.js'

const id = {
  account: '73000000-0000-4000-8000-000000000000',
  object: '73000000-0000-4000-8000-000000000006',
  project: '73000000-0000-4000-8000-000000000001',
  document: '73000000-0000-4000-8001-000000000001',
  representation: '73000000-0000-4000-8002-000000000001',
  schema: '73000000-0000-4000-8003-000000000001',
} as const

const historicalNodes = [
  { id: 'z', name: 'zeta', type: 'string' },
  {
    id: 'g',
    name: 'group',
    type: 'object',
    children: [
      { id: 'b', name: 'beta', type: 'number' },
      { id: 'a', name: 'alpha', type: 'string' },
    ],
  },
  { id: 'a2', name: 'alpha', type: 'boolean' },
] as const

const currentNodes = [
  { id: 'current-title', name: 'document_title', type: 'string' },
] as const

const pdfPath = fileURLToPath(
  new URL('../../../examples/1790-06-17-1.pdf', import.meta.url),
)
const parsedDocumentPath = fileURLToPath(
  new URL('../src/assets/parsed_document.v2.json', import.meta.url),
)

async function installArtifactRoutes(page: Page) {
  const [pdf, parsedDocument] = await Promise.all([
    readFile(pdfPath),
    readFile(parsedDocumentPath, 'utf8'),
  ])
  await page.route(
    `**/api/project-contexts/${id.project}/source-representations/${id.representation}/pdf**`,
    (route) => route.fulfill({ body: pdf, contentType: 'application/pdf' }),
  )
  await page.route(
    `**/api/project-contexts/${id.project}/source-representations/${id.representation}/markdown**`,
    (route) =>
      route.fulfill({
        body: '# Ordered schema',
        contentType: 'text/markdown',
      }),
  )
  await page.route(
    `**/api/project-contexts/${id.project}/source-representations/${id.representation}/source**`,
    (route) =>
      route.fulfill({
        body: parsedDocument,
        contentType: 'application/json',
      }),
  )
}

test.beforeAll(async () => {
  if (!process.env.SCHEMA_ORDER_E2E) return
  const { db } = await import('../../../packages/db/src/prisma/db.js')
  await db.orm.public.ResearcherAccount.create({
    id: id.account,
    tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
    objectId: id.object,
    displayName: 'Schema Order Researcher',
  })
  await db.orm.public.ProjectContext.create({
    id: id.project,
    researcherAccountId: id.account,
    name: 'Ordered schema E2E',
  })
  await db.orm.public.SourceDocument.create({
    id: id.document,
    projectContextId: id.project,
    ingestionKey: '51000000-0000-4000-9000-000000000003',
    contentSha256: 'a'.repeat(64),
    mediaType: 'application/pdf',
    originalName: '1790-06-17-1.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    id: id.representation,
    sourceDocumentId: id.document,
    revisionNumber: 1,
    artifactReference: 'schema-order-e2e',
    artifactSha256: 'b'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: 'schema-order-e2e',
    parserName: 'fixture',
    parserVersion: '1',
  })
  await db.orm.public.ExtractionSchema.create({
    id: id.schema,
    projectContextId: id.project,
    name: 'Deliberately non-alphabetical',
  })
  await db.orm.public.SchemaRevision.create({
    id: '73000000-0000-4000-8004-000000000001',
    extractionSchemaId: id.schema,
    revisionNumber: 1,
    origin: 'RESEARCHER_EDIT',
    schemaTree: {
      recordDescription: 'One deliberately ordered record.',
      schemaNodes: historicalNodes,
    },
  })
  await db.orm.public.SchemaRevision.create({
    id: '73000000-0000-4000-8004-000000000002',
    extractionSchemaId: id.schema,
    revisionNumber: 2,
    origin: 'RESEARCHER_EDIT',
    schemaTree: {
      recordDescription: 'One current record.',
      schemaNodes: currentNodes,
    },
  })
})

test('restored JSONB schema order survives a fresh browser @database', async ({
  browser,
  page,
}) => {
  test.setTimeout(60_000)
  test.skip(!process.env.SCHEMA_ORDER_E2E, 'Requires the disposable PostgreSQL stack.')
  await loginResearcher(page, id.object)

  const reopened = await page.request.get(
    `/api/project-contexts/${id.project}/source-documents/${id.document}/reopen`,
  )
  expect(reopened.ok()).toBe(true)
  const durable = (await reopened.json()) as {
    extractionSchema: { schemaNodes: Array<{ name: string; children?: Array<{ name: string }> }> }
  }
  expect(durable.extractionSchema.schemaNodes.map(({ name }) => name)).toEqual([
    'document_title',
  ])

  await installArtifactRoutes(page)
  await page.goto(`/projects/${id.project}/documents/${id.document}`)
  await page.getByRole('tab', { name: /^Schema / }).click()
  const history = page.getByRole('button', { name: 'Schema history' })
  await expect(history).toBeEnabled({ timeout: 15_000 })
  await history.click()
  await page.getByRole('button', { name: /^Revision 1:/ }).click()

  await expect(page.getByText('Viewing historical Schema Revision 1. This preview is read-only.')).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Add field' })).toHaveCount(0)

  const previewTimeline = await page.request.get(
    `/api/schema-revisions?projectContextId=${id.project}&extractionSchemaId=${id.schema}&limit=20`,
  )
  const previewBody = (await previewTimeline.json()) as {
    revisions: Array<{ revisionNumber: number }>
  }
  expect(previewBody.revisions[0]?.revisionNumber).toBe(2)

  await page.getByRole('button', { name: 'Create Current Schema Revision' }).click()

  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/schema-revisions?projectContextId=${id.project}&extractionSchemaId=${id.schema}&limit=20`,
    )
    const body = (await response.json()) as { revisions: Array<{ revisionNumber: number }> }
    return body.revisions[0]?.revisionNumber
  }).toBe(3)

  const timeline = await page.request.get(
    `/api/schema-revisions?projectContextId=${id.project}&extractionSchemaId=${id.schema}&limit=20`,
  )
  const latest = (await timeline.json()) as {
    revisions: Array<{ schemaRevisionId: string; revisionNumber: number }>
  }
  const restored = await page.request.get(
    `/api/schema-revisions/${latest.revisions[0].schemaRevisionId}?projectContextId=${id.project}&extractionSchemaId=${id.schema}`,
  )
  const restoredBody = (await restored.json()) as { revision: { schemaNodes: unknown } }
  expect(restoredBody.revision.schemaNodes).toEqual(historicalNodes)

  await page.close()
  const freshContext = await browser.newContext()
  const freshPage = await freshContext.newPage()
  await loginResearcher(freshPage, id.object)
  await installArtifactRoutes(freshPage)
  await freshPage.goto(`/projects/${id.project}/documents/${id.document}`)
  await freshPage.getByRole('tab', { name: /^Schema / }).click()
  const freshHistory = freshPage.getByRole('button', { name: 'Schema history' })
  await expect(freshHistory).toBeEnabled({ timeout: 15_000 })
  await freshHistory.click()
  await expect(freshPage.getByText('Revision 3 · Current')).toBeVisible()
  const fieldButtons = freshPage.locator(
    'button[title="Edit zeta"], button[title="Edit group"], button[title="Edit beta"], button[title="Edit alpha"]',
  )
  await expect(fieldButtons).toHaveCount(5)
  expect(
    await fieldButtons.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('title')),
    ),
  ).toEqual([
    'Edit zeta',
    'Edit group',
    'Edit beta',
    'Edit alpha',
    'Edit alpha',
  ])
  await freshContext.close()
})
