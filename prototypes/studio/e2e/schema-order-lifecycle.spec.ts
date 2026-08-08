import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const id = {
  project: '73000000-0000-4000-8000-000000000001',
  document: '73000000-0000-4000-8001-000000000001',
  representation: '73000000-0000-4000-8002-000000000001',
} as const

const pdfPath = fileURLToPath(
  new URL('../../../examples/1790-06-17-1.pdf', import.meta.url),
)
const parsedDocumentPath = fileURLToPath(
  new URL('../src/assets/parsed_document.v2.json', import.meta.url),
)

function submittedTemplate(body: string): Record<string, unknown> {
  const match = /name="template"\r?\n\r?\n([^\r\n]+)/u.exec(body)
  if (!match) throw new Error('Model request omitted its template field.')
  return JSON.parse(match[1]) as Record<string, unknown>
}

async function installModelAndArtifactRoutes(
  page: Page,
  extractionTemplates: Record<string, unknown>[],
) {
  const [pdf, parsedDocument] = await Promise.all([
    readFile(pdfPath),
    readFile(parsedDocumentPath, 'utf8'),
  ])
  await page.route('**/api/extract', async (route) => {
    const template = submittedTemplate(route.request().postData() ?? '')
    if ('records' in template) {
      extractionTemplates.push(template)
      return route.fulfill({
        json: {
          result: {
            records: [
              {
                zeta: 'last alphabetically',
                group: { beta: 2, alpha: 'nested second' },
                alpha: true,
              },
            ],
          },
          reasoning: null,
          raw: '{}',
          pages: null,
          modelAttribution: { provider: 'fixture', modelId: 'ordered-values' },
        },
      })
    }
    const links = Object.fromEntries(
      Object.keys(template.links as Record<string, unknown>).map((claim) => [
        claim,
        'NONE',
      ]),
    )
    return route.fulfill({
      json: {
        result: { links },
        reasoning: null,
        raw: JSON.stringify({ links }),
        pages: null,
        modelAttribution: { provider: 'fixture', modelId: 'ordered-grounding' },
      },
    })
  })
  await page.route(
    `**/api/source-representations/${id.representation}/pdf`,
    (route) => route.fulfill({ body: pdf, contentType: 'application/pdf' }),
  )
  await page.route(
    `**/api/source-representations/${id.representation}/markdown`,
    (route) => route.fulfill({ body: '# Ordered schema', contentType: 'text/markdown' }),
  )
  await page.route(
    `**/api/source-representations/${id.representation}/source`,
    (route) => route.fulfill({ body: parsedDocument, contentType: 'application/json' }),
  )
}

test.beforeAll(async () => {
  if (!process.env.SCHEMA_ORDER_E2E) return
  const { db } = await import('../../../packages/db/src/prisma/db.js')
  await db.orm.public.ProjectContext.create({
    id: id.project,
    name: 'Ordered schema E2E',
  })
  await db.orm.public.SourceDocument.create({
    id: id.document,
    projectContextId: id.project,
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
  const extractionSchemaId = '73000000-0000-4000-8003-000000000001'
  await db.orm.public.ExtractionSchema.create({
    id: extractionSchemaId,
    projectContextId: id.project,
    name: 'Deliberately non-alphabetical',
  })
  await db.orm.public.SchemaRevision.create({
    id: '73000000-0000-4000-8004-000000000001',
    extractionSchemaId,
    revisionNumber: 1,
    origin: 'RESEARCHER_EDIT',
    schemaTree: [
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
    ],
  })
})

test('JSONB schema order survives reopen and reaches NuExtract @database', async ({
  browser,
  page,
}) => {
  test.skip(!process.env.SCHEMA_ORDER_E2E, 'Requires the disposable PostgreSQL stack.')

  const reopened = await page.request.get(
    `/api/project-contexts/${id.project}/source-documents/${id.document}/reopen`,
  )
  expect(reopened.ok()).toBe(true)
  const durable = (await reopened.json()) as {
    extractionSchema: { schemaNodes: Array<{ name: string; children?: Array<{ name: string }> }> }
  }
  expect(durable.extractionSchema.schemaNodes.map(({ name }) => name)).toEqual([
    'zeta',
    'group',
    'alpha',
  ])
  expect(
    durable.extractionSchema.schemaNodes[1].children?.map(({ name }) => name),
  ).toEqual(['beta', 'alpha'])

  const templates: Record<string, unknown>[] = []
  await installModelAndArtifactRoutes(page, templates)
  await page.goto(`/projects/${id.project}/documents/${id.document}`)
  const run = page.getByRole('button', { name: '▶ Run extraction' })
  await expect(run).toBeEnabled({ timeout: 15_000 })
  await run.click()
  await expect(page.getByRole('button', { name: 'Raw JSON' })).toBeVisible({
    timeout: 15_000,
  })

  await page.close()
  const freshContext = await browser.newContext()
  const freshPage = await freshContext.newPage()
  await installModelAndArtifactRoutes(freshPage, templates)
  await freshPage.goto(`/projects/${id.project}/documents/${id.document}`)
  const rerun = freshPage.getByRole('button', { name: '▶ Run extraction' })
  await expect(rerun).toBeEnabled({ timeout: 15_000 })
  await rerun.click()
  await expect(freshPage.getByRole('button', { name: 'Raw JSON' })).toBeVisible({
    timeout: 15_000,
  })
  await freshContext.close()

  expect(templates).toHaveLength(2)
  for (const template of templates) {
    const record = (template.records as [Record<string, unknown>])[0]
    expect(Object.keys(record)).toEqual(['zeta', 'group', 'alpha'])
    expect(Object.keys(record.group as Record<string, unknown>)).toEqual([
      'beta',
      'alpha',
    ])
  }
  expect(templates[1]).toEqual(templates[0])
})
