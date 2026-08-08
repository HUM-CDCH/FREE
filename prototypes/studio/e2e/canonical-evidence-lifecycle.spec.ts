import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import type {
  DocumentReopenSnapshot,
  ProjectStore,
} from '../../../packages/db/src/project-store.js'
import { createGetDocumentReopen } from '../api/document_reopen.js'
import { createGetProjectContexts } from '../api/project_contexts.js'
import { createPersistReviewedExtraction } from '../api/source_representations.js'

const id = {
  project: '72000000-0000-4000-8000-000000000001',
  document: '72000000-0000-4000-8001-000000000001',
  representation: '72000000-0000-4000-8002-000000000001',
  extraction: '72000000-0000-4000-8003-000000000001',
  schemaRevision: '72000000-0000-4000-8005-000000000001',
} as const

const pdfPath = fileURLToPath(
  new URL('../../../examples/Beretning_Ellekilde_8_13.pdf', import.meta.url),
)
const semanticGoldenPath = fileURLToPath(
  new URL(
    '../../parsing_service/tests/golden/Beretning_Ellekilde_8_13.golden.json',
    import.meta.url,
  ),
)

const accepted = {
  find_number: {
    value: '24-1',
    anchor_id:
      'anchor_442f28492c1da6d8adda29faf541ed29ecfe5a8c36304aa584a147057b3188b8',
  },
  description: {
    value: 'Lerkar, ornamenteret sortbrunt',
    anchor_id:
      'anchor_3f8b634336fd171fe4c4b258d5c189fb28e876e34e4a236b1aa8e102ec5c1a36',
  },
  remarks: {
    value: 'Fundet stående på gravens bundlag, 30 cm dybde.',
    anchor_id:
      'anchor_8843344f881452f4eb509820cc92a44778ec08fad14d1069f02b77a3781e14e3',
  },
} as const

const rowAnchors = Object.values(accepted).map((field, column) => ({
  kind: 'table_cell',
  anchor_id: field.anchor_id,
  content_sha256: 'fbd6884163b68656687d4c6ab7395be6ea306a5faf7b94253f18eb50c60b9679',
  preprocess_id:
    'sha256:4e311f639c276f6da0d11f7289cdc015c7b3353495c469a1b4696f02e112ee4c',
  logical_table_id:
    'table_ce3ef0d0ea9fd296f55fb277c8ee95ab56b5563244e9340cad7853f4a9858c6e',
  cell_id: `row-24-1-column-${column}`,
  canonical_row: 1,
  canonical_column: column,
  producer_observations: [
    {
      occurrence_id: `${field.anchor_id}@p3`,
      page_number: 3,
      producer_ref: 'ellekilde-row-24-1',
      row_offset: 1,
      column_offset: column,
      row_span: 1,
      column_span: 1,
      bbox: { x0: 60 + column * 150, y0: 180, x1: 190 + column * 150, y1: 202 },
    },
  ],
}))

const rotatedAnchor = {
  kind: 'text',
  anchor_id: 'anchor_rotated_geometry',
  occurrence_id: 'occurrence_rotated_geometry',
  content_sha256: rowAnchors[0].content_sha256,
  preprocess_id: rowAnchors[0].preprocess_id,
  block_id: 'block-rotated-geometry',
  page_number: 2,
  markdown_span: { start: 0, end: 1 },
  bbox: { x0: 10, y0: 10, x1: 80, y1: 20 },
} as const

const parsedDocument = {
  schema_version: 'parsed_document.v2',
  document: {
    document_id: 'document_ellekilde_lifecycle',
    content_sha256: rowAnchors[0].content_sha256,
    source: {
      kind: 'upload',
      original_filename: 'Beretning_Ellekilde_8_13.pdf',
      media_type: 'application/pdf',
      byte_size: null,
    },
    created_at: '2026-08-07T00:00:00Z',
    page_count: 6,
    language_hints: ['da'],
    is_encrypted: false,
    input_profile: {
      file_kind: 'pdf',
      detected_mime: 'application/pdf',
      pdf_version: null,
      has_text_layer: true,
      has_images: true,
    },
  },
  preprocessing: {
    preprocess_id: rowAnchors[0].preprocess_id,
    profile: 'production_default',
    service_version: 'lifecycle-fixture',
    started_at: null,
    finished_at: null,
    status: 'completed',
    warnings: [],
  },
  page_count: 6,
  page_mapping_verified: true,
  artifacts: {
    source_ref: 'source.pdf',
    parsed_json_ref: 'parsed_document.json',
    markdown_ref: 'artifacts/document.llm.md',
  },
  parser_runs: [],
  arbitration: null,
  diagnostics: [],
  content_stream: [
    {
      kind: 'paragraph',
      block_id: 'block-rotated-geometry',
      page_number: 2,
      parser: 'fixture',
      bbox: rotatedAnchor.bbox,
      markdown_span: rotatedAnchor.markdown_span,
      text: 'Rotated geometry',
    },
  ],
  pages: Array.from({ length: 6 }, (_, index) => ({
    page_number: index + 1,
    width_pt: 612,
    height_pt: 792,
    rotation: index === 1 ? 90 : 0,
    ordered_content:
      index === 1
          ? ['block-rotated-geometry']
          : [],
    unplaced_content:
      index === 2 ? [rowAnchors[0].logical_table_id] : [],
    markdown_span: null,
  })),
  tables: [
    {
      table_id: rowAnchors[0].logical_table_id,
      rows: 2,
      cols: 3,
      cells: rowAnchors.map((anchor, column) => ({
        cell_id: anchor.cell_id,
        row: 1,
        column,
        text: Object.values(accepted)[column].value,
        role: null,
        rowspan: 1,
        colspan: 1,
        bbox: anchor.producer_observations[0].bbox,
        evidence_anchor_id: anchor.anchor_id,
      })),
      spans: [
        {
          page_number: 3,
          producer_table_ref: 'ellekilde-row-24-1',
          page_local_row_start: 0,
          page_local_row_end: 1,
          page_local_col_count: 3,
        },
      ],
      parser_attribution: {
        content_parser: { parser: 'docling_table', version: null },
        structure_parser: { parser: 'docling_table', version: null },
        geometry_parser: { parser: 'docling_table', version: null },
      },
      continuation: 'page_local',
    },
  ],
  evidence_index: { anchors: [rotatedAnchor, ...rowAnchors] },
}

type State = { extraction: DocumentReopenSnapshot['extraction'] }

const createdAt = {
  project: new Date('2026-08-07T00:00:00.000Z'),
  document: new Date('2026-08-07T00:01:00.000Z'),
  extraction: new Date('2026-08-07T00:02:00.000Z'),
}

function lifecycleStore(state: State): ProjectStore {
  const projectContext = {
    projectContextId: id.project,
    name: 'Ellekilde lifecycle',
    createdAt: createdAt.project,
  }
  const sourceDocument = {
    sourceDocumentId: id.document,
    name: 'Beretning_Ellekilde_8_13.pdf',
    createdAt: createdAt.document,
  }
  return {
    async listProjectContexts() {
      return [projectContext]
    },
    async getProjectContextWithDocuments(projectContextId) {
      return projectContextId === id.project
        ? { projectContext, sourceDocuments: [sourceDocument] }
        : null
    },
    async getDocumentReopenSnapshot(projectContextId, sourceDocumentId) {
      if (projectContextId !== id.project || sourceDocumentId !== id.document)
        return null
      return {
        projectContext,
        sourceDocument,
        sourceRepresentation: {
          sourceRepresentationId: id.representation,
          revisionNumber: 1,
          createdAt: createdAt.document,
        },
        annotationSet: null,
        extractionSchema: null,
        extraction: state.extraction,
      }
    },
    async getSourceRepresentation(sourceRepresentationId) {
      return sourceRepresentationId === id.representation
        ? { artifactReference: 'ellekilde-lifecycle', artifactSha256: 'f'.repeat(64) }
        : null
    },
    async persistReviewedExtraction(sourceRepresentationId, input) {
      if (sourceRepresentationId !== id.representation) return null
      state.extraction = {
        extractionId: id.extraction,
        createdAt: createdAt.extraction,
        outcome: 'SUCCEEDED',
        resultPayload: input.resultPayload,
        failure: null,
        reviewDecisions: input.reviewDecisions.map((decision, index) => ({
          reviewDecisionId: `72000000-0000-4000-8004-00000000000${index + 1}`,
          ...decision,
        })),
      }
      return { extractionId: id.extraction, createdAt: createdAt.extraction }
    },
  }
}

async function installLifecycleFixture(page: Page, state: State) {
  const pdf = await readFile(pdfPath)
  const store = lifecycleStore(state)
  const projectContexts = createGetProjectContexts(store)
  const reopen = createGetDocumentReopen(store)
  const persist = createPersistReviewedExtraction(
    store,
    async () => Response.json(parsedDocument),
  )
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const fulfill = async (response: Response) =>
      route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      })
    if (path.startsWith('/api/project-contexts'))
      return fulfill(
        await (path.endsWith('/reopen') ? reopen : projectContexts)(
          new Request(request.url()),
        ),
      )
    if (path.endsWith('/extraction-reviews'))
      return fulfill(
        await persist(
          new Request(request.url(), {
            method: request.method(),
            headers: request.headers(),
            body: request.postData(),
          }),
        ),
      )
    if (path.endsWith('/pdf'))
      return route.fulfill({ body: pdf, contentType: 'application/pdf' })
    if (path.endsWith('/markdown'))
      return route.fulfill({ body: '# Ellekilde\n\n24-1', contentType: 'text/markdown' })
    if (path.endsWith('/source'))
      return route.fulfill({ json: parsedDocument })
    return route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Fixture route missing.' } },
    })
  })
}

test('canonical Evidence survives persist, fresh reopen, and safe rendering @deterministic', async ({
  browser,
  page,
}) => {
  const golden = JSON.parse(await readFile(semanticGoldenPath, 'utf8')) as {
    schema_version: string
    page_count: number
  }
  expect(parsedDocument.schema_version).toBe(golden.schema_version)
  expect(parsedDocument.page_count).toBe(golden.page_count)

  const state: State = { extraction: null }
  await installLifecycleFixture(page, state)
  await page.goto(
    `/projects/${id.project}/documents/${id.document}`,
  )
  await expect(page.getByText('6 pages · text highlights only')).toBeVisible({
    timeout: 15_000,
  })

  const reviewDecisions = rowAnchors.map((anchor) => ({
    evidenceAnchorId: anchor.anchor_id,
    reviewedOccurrenceIds: [anchor.producer_observations[0].occurrence_id],
  }))
  const status = await page.evaluate(
    async ({ representation, schemaRevision, result, decisions }) =>
      (
        await fetch(
          `/api/source-representations/${representation}/extraction-reviews`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              schemaRevisionId: schemaRevision,
              result,
              modelAttribution: { provider: 'fixture', model: 'accepted-output' },
              reviewDecisions: decisions,
            }),
          },
        )
      ).status,
    {
      representation: id.representation,
      schemaRevision: id.schemaRevision,
      result: accepted,
      decisions: reviewDecisions,
    },
  )
  expect(status).toBe(201)

  await page.close()
  const reopenedContext = await browser.newContext()
  const reopened = await reopenedContext.newPage()
  await installLifecycleFixture(reopened, state)
  await reopened.goto(
    `/projects/${id.project}/documents/${id.document}`,
  )
  await expect(reopened.getByText('6 pages · text highlights only')).toBeVisible({
    timeout: 15_000,
  })
  await reopened.getByRole('tab', { name: /Evidence/ }).click()

  for (const decision of reviewDecisions)
    await expect(
      reopened.getByRole('button', {
        name: new RegExp(`Evidence anchor ${decision.evidenceAnchorId}`),
      }),
    ).toContainText('reviewed occurrence')

  const valid = reviewDecisions[0].reviewedOccurrenceIds[0]
  await reopened
    .getByRole('button', {
      name: new RegExp(`Evidence anchor ${reviewDecisions[0].evidenceAnchorId}`),
    })
    .click()
  await expect(
    reopened.locator(
      `.parsed-evidence-focus[data-occurrence-id="${valid}"]`,
    ),
  ).toHaveCount(1)

  await reopened
    .getByRole('button', {
      name: new RegExp(`Evidence anchor ${rotatedAnchor.anchor_id}`),
    })
    .click()
  await expect(
    reopened.locator(
      `.parsed-evidence-focus[data-occurrence-id="${rotatedAnchor.occurrence_id}"]`,
    ),
  ).toHaveCount(1)
  await reopenedContext.close()
})
