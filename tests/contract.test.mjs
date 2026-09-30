// Black-box proof of the FREE product contract against this test's disposable
// Compose stack. Extraction uses the scripted external model fixture.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  API,
  BASE,
  ORIGIN,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  Session,
  collectGarbageNow,
  compose,
  ensureStackUp,
  probePdf,
  waitForHealth,
} from './helpers.mjs'

before(async () => {
  await ensureStackUp()
}, { timeout: 900_000 })

const session = new Session()
const state = {}

test('startup: health endpoint answers only after the stack is ready', async () => {
  const response = await fetch(`${API}/healthz`)
  assert.equal(response.status, 200)
})

test('startup: the site root redirects into the /free base path', async () => {
  const response = await fetch(`${ORIGIN}/`, { redirect: 'manual' })
  assert.equal(response.status, 308)
  assert.equal(
    new URL(response.headers.get('location'), ORIGIN).pathname,
    '/free/',
  )
})

test('authentication: research APIs refuse anonymous requests', async () => {
  for (const path of ['/project-contexts', '/model_config', '/extractions/x']) {
    const response = await fetch(`${API}${path}`)
    assert.equal(response.status, 401, path)
  }
})

test('authentication: unauthenticated app pages redirect to sign-in', async () => {
  const anonymous = new Session()
  const response = await anonymous.fetch(`${BASE}/`)
  assert.equal(response.status, 302)
  assert.match(response.headers.get('location'), /auth\/login/)
})

test('authentication: the mock OIDC flow produces a working session', async () => {
  await session.login()
  const { status } = await session.api('/project-contexts')
  assert.equal(status, 200)
})

test('authentication: cross-origin writes are rejected', async () => {
  const response = await session.fetch(`${API}/project-contexts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'nope' }),
  })
  assert.equal(response.status, 403)
})

test('projects: create, list, rename', async () => {
  const created = await session.api('/project-contexts', {
    method: 'POST',
    body: JSON.stringify({ name: 'Contract Suite' }),
  })
  assert.equal(created.status, 201)
  state.projectId = created.body.projectContext.projectContextId

  const listed = await session.api('/project-contexts')
  assert.ok(
    listed.body.projectContexts.some(
      (project) => project.projectContextId === state.projectId,
    ),
  )

  const renamed = await session.api(`/project-contexts/${state.projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Contract Suite (renamed)' }),
  })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.projectContext.name, 'Contract Suite (renamed)')
})

test('ingestion: a PDF source document uploads and parses', { timeout: 300_000 }, async () => {
  const form = new FormData()
  form.append(
    'file',
    new File([probePdf()], 'probe.pdf', { type: 'application/pdf' }),
  )
  const response = await session.api(
    `/project-contexts/${state.projectId}/source-documents`,
    { method: 'POST', body: form },
  )
  // Studio answers once it admits the attempt; the Source Ingestion listing reports it until it publishes.
  assert.equal(response.status, 202, JSON.stringify(response.body))
  const { workflowId } = response.body
  const deadline = Date.now() + 280_000
  let listed
  while (Date.now() < deadline) {
    const listing = await session.api(
      `/project-contexts/${state.projectId}/source-ingestions?workflowId=${encodeURIComponent(workflowId)}`,
    )
    assert.equal(listing.status, 200, JSON.stringify(listing.body))
    listed = listing.body.ingestions.find((ingestion) => ingestion.workflowId === workflowId)
    if (listed?.status === 'succeeded' || listed?.status === 'failed') break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  assert.equal(listed?.status, 'succeeded', JSON.stringify(listed))
  state.sourceDocumentId = listed.sourceDocumentId
  const project = await session.api(`/project-contexts/${state.projectId}`)
  assert.equal(project.status, 200, JSON.stringify(project.body))
  const document = project.body.sourceDocuments.find((item) => item.sourceDocumentId === state.sourceDocumentId)
  assert.equal(document?.pageCount, 1)
  const reopen = await session.api(`/project-contexts/${state.projectId}/source-documents/${state.sourceDocumentId}/reopen`)
  assert.equal(reopen.status, 200, JSON.stringify(reopen.body))
  state.sourceRepresentationRevisionId = reopen.body.sourceRepresentation.sourceRepresentationId
})

test('ingestion: a non-PDF upload is rejected', async () => {
  const form = new FormData()
  form.append('file', new File(['not a pdf'], 'probe.pdf', { type: 'application/pdf' }))
  const response = await session.api(
    `/project-contexts/${state.projectId}/source-documents`,
    { method: 'POST', body: form },
  )
  assert.equal(response.status, 400)
})

test('schema: a researcher-approved schema revision is stored', async () => {
  const response = await session.api('/schema-revisions', {
    method: 'POST',
    body: JSON.stringify({
      projectContextId: state.projectId,
      recordDescription: 'A historical publication event',
      schemaNodes: [
        { id: 'author', name: 'author', type: 'string', description: 'Person or body named' },
        { id: 'year', name: 'year', type: 'number', description: 'Year mentioned' },
        { id: 'place', name: 'place', type: 'string', description: 'City mentioned' },
      ],
    }),
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
  state.schemaRevisionId = response.body.revision.schemaRevisionId
})

test('extraction: the canonical schema-guided path succeeds with evidence', { timeout: 600_000 }, async () => {
  const configured = await session.api('/model_config', {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        connections: [
          {
            id: (state.connectionId = crypto.randomUUID()),
            name: 'Contract Ollama',
            provider: 'ollama',
            baseUrl: OLLAMA_BASE_URL,
            hasKey: false,
          },
        ],
        routes: {
          schemaSuggestion: { connectionId: state.connectionId, modelId: OLLAMA_MODEL },
          interaction: { connectionId: state.connectionId, modelId: OLLAMA_MODEL },
        },
        extractionModels: {},
        ingestionModels: {},
        extractionSettings: {},
      },
    }),
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.body))

  const extraction = await session.api('/extractions', {
    method: 'POST',
    body: JSON.stringify({
      id: (state.extractionId = crypto.randomUUID()),
      sourceRepresentationRevisionId: state.sourceRepresentationRevisionId,
      schemaRevisionId: state.schemaRevisionId,
      strategy: 'ARTICLE',
      // The method the account saved just above: no Extraction Model Choice, service-default settings.
      method: { models: null, settings: { article: null } },
    }),
  })
  assert.equal(extraction.status, 201, JSON.stringify(extraction.body))
  assert.ok(['QUEUED', 'RUNNING', 'COMPLETED'].includes(extraction.body.executionStatus))

  const deadline = Date.now() + 600_000
  let completed
  while (Date.now() < deadline) {
    const detail = await session.api(`/extractions/${state.extractionId}`)
    assert.equal(detail.status, 200)
    const attempt = detail.body.extraction
    if (attempt.executionStatus === 'FAILED')
      assert.fail(`Extraction failed: ${JSON.stringify(attempt.failure)}`)
    if (attempt.executionStatus === 'COMPLETED') {
      completed = attempt
      break
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  assert.ok(completed, 'Extraction did not finish before the deadline')
  assert.equal(completed.outcome, 'SUCCEEDED')

  // The run produced Evidence links and reported its grounding diagnostic.
  // That grounded and ungrounded together cover every populated value is a
  // property of grounding.ts, pinned in packages/extraction/src/grounding.test.ts;
  // asserting it here can only restate what the response already computed.
  assert.ok(completed.evidenceLinks.length > 0)
  assert.ok(Array.isArray(completed.diagnostics.grounding.ungroundedPaths))
})

test('review: partial review decisions are rejected (data integrity)', async () => {
  const detail = await session.api(`/extractions/${state.extractionId}`)
  assert.equal(detail.status, 200)
  state.pendingReviewDecisions = detail.body.pendingReviewDecisions
  assert.ok(state.pendingReviewDecisions.length > 0)

  const partial = await session.api(`/extractions/${state.extractionId}/review`, {
    method: 'POST',
    body: JSON.stringify({
      reviewDecisions: state.pendingReviewDecisions.slice(0, 1),
    }),
  })
  assert.equal(partial.status, 422)
})

test('review: complete accept/reject decisions are stored', async () => {
  const decisions = state.pendingReviewDecisions.map((decision, index) => ({
    ...decision,
    action: index === 0 ? 'REJECTED' : 'APPROVED',
  }))
  const response = await session.api(`/extractions/${state.extractionId}/review`, {
    method: 'POST',
    body: JSON.stringify({ reviewDecisions: decisions }),
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))

  const stored = await session.api(`/extractions/${state.extractionId}`)
  assert.equal(
    stored.body.extraction.reviewDecisions.length,
    decisions.length,
  )
})

/** A native-text PDF of `pages` pages (about 3,000 characters each), each opening with PAGESTARTnn (plus æøå) and closing with PAGEENDnn. */
function catalogPdf(pages) {
  const bodies = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']
  const kids = []
  for (let page = 1; page <= pages; page += 1) {
    const number = String(page).padStart(2, '0')
    const lines = [`PAGESTART${number} æøå`]
    for (let line = 1; line <= 38; line += 1)
      lines.push(`Entry ${number}.${String(line).padStart(2, '0')} records a grave with finds of pottery and bone near the church.`)
    lines.push(`PAGEEND${number}`)
    const stream = `BT /F1 10 Tf 40 760 Td ${lines.map((line, index) => `${index === 0 ? '' : '0 -14 Td '}(${line}) Tj`).join(' ')} ET`
    const pageObject = bodies.length + 1
    kids.push(`${pageObject} 0 R`)
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObject + 1} 0 R >>`)
    bodies.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  bodies[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= bodies.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

test('schema suggestion: a large parsed source is excerpted page by page and declares the real pages it left out', { timeout: 900_000 }, async () => {
  const PAGES = 30
  const form = new FormData()
  form.append('file', new File([catalogPdf(PAGES)], 'catalogue.pdf', { type: 'application/pdf' }))
  const upload = await session.api(`/project-contexts/${state.projectId}/source-documents`, { method: 'POST', body: form })
  assert.equal(upload.status, 202, JSON.stringify(upload.body))
  const { workflowId } = upload.body
  const deadline = Date.now() + 600_000
  let listed
  while (Date.now() < deadline) {
    const listing = await session.api(`/project-contexts/${state.projectId}/source-ingestions?workflowId=${encodeURIComponent(workflowId)}`)
    assert.equal(listing.status, 200, JSON.stringify(listing.body))
    listed = listing.body.ingestions.find((ingestion) => ingestion.workflowId === workflowId)
    if (listed?.status === 'succeeded' || listed?.status === 'failed') break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
  }
  assert.equal(listed?.status, 'succeeded', JSON.stringify(listed))
  const reopen = await session.api(`/project-contexts/${state.projectId}/source-documents/${listed.sourceDocumentId}/reopen`)
  assert.equal(reopen.status, 200, JSON.stringify(reopen.body))
  const revisionId = reopen.body.sourceRepresentation.sourceRepresentationId
  const { markdownUrl, parsedDocumentUrl } = reopen.body.sourceRepresentation.resources
  const markdownResponse = await session.fetch(`${BASE}${markdownUrl}`)
  assert.equal(markdownResponse.status, 200, markdownUrl)
  const markdownBytes = Buffer.from(await markdownResponse.arrayBuffer())
  const markdown = markdownBytes.toString('utf8')
  // The stored page spans are UTF-8 byte ranges of this Markdown: each page's span holds that page's own head and tail.
  const parsedResponse = await session.fetch(`${BASE}${parsedDocumentUrl}`)
  assert.equal(parsedResponse.status, 200, parsedDocumentUrl)
  const parsed = await parsedResponse.json()
  console.log('parsed_document keys: ' + Object.keys(parsed).join(','))
  assert.ok(Array.isArray(parsed.pages), 'parsed_document.json has top-level pages')
  assert.equal(parsed.pages.length, PAGES)
  for (const page of parsed.pages) {
    const token = String(page.page_number).padStart(2, '0')
    const span = markdownBytes.subarray(page.markdown_span.start, page.markdown_span.end).toString('utf8')
    assert.ok(span.includes(`PAGESTART${token}`) && span.includes(`PAGEEND${token}`), `page ${page.page_number}: its stored span holds its own head and tail`)
  }
  console.log(`catalogue: ${markdown.length} characters`)
  assert.ok(markdown.length > 48_000, `the probe source must exceed the excerpt threshold (${markdown.length})`)
  assert.ok(!/FREE:PAGE/.test(markdown), 'the canonical Markdown carries no page marker')

  // Route Schema Suggestion at the scripted model (an OpenAI-compatible vLLM endpoint inside the stack).
  const connectionId = crypto.randomUUID()
  const configured = await session.api('/model_config', {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        connections: [{ id: connectionId, name: 'Scripted', provider: 'vllm', baseUrl: 'http://contract-model:8000/v1', hasKey: false }],
        routes: { schemaSuggestion: { connectionId, modelId: 'contract-fixture' }, interaction: { connectionId, modelId: 'contract-fixture' } },
        extractionModels: {},
        ingestionModels: {},
        extractionSettings: {},
      },
    }),
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.body))

  const suggestion = new FormData()
  suggestion.append('project_context_id', state.projectId)
  suggestion.append('source_representation_revision_id', revisionId)
  suggestion.append('operation_id', crypto.randomUUID())
  suggestion.append('instruction', 'Suggest the fields of one grave entry.')
  const generated = await session.api('/generate_schema', { method: 'POST', body: suggestion })
  assert.equal(generated.status, 200, JSON.stringify(generated.body).slice(0, 600))
  const coverage = generated.body.sourceCoverage
  console.log('coverage: ' + JSON.stringify({ ...coverage, omitted: coverage?.omitted?.length }))
  assert.equal(coverage?.complete, false, 'a source over the threshold is declared excerpted')
  assert.equal(coverage.sourceCharacters, markdown.length, 'sourceCharacters is the whole Markdown, in UTF-16 characters')
  const pages = coverage.omitted.map((omission) => omission.page)
  assert.ok(pages.every((page) => Number.isInteger(page)), `every omission names its physical page, got ${JSON.stringify(pages)}`)
  assert.deepEqual(pages, Array.from({ length: PAGES }, (_, index) => index + 1), 'one omission per physical page, in order')
  for (const { page, start, end } of coverage.omitted) {
    const omitted = markdown.slice(start, end)
    const token = String(page).padStart(2, '0')
    assert.ok(end > start && end <= markdown.length, `page ${page}: range ${start}-${end}`)
    assert.ok(!omitted.includes(`PAGESTART${token}`) && !omitted.includes(`PAGEEND${token}`), `page ${page}: the omitted middle holds the page's own head or tail`)
    assert.ok(markdown.slice(0, start).includes(`PAGESTART${token}`), `page ${page}: its head precedes the omission`)
    assert.ok(markdown.slice(end).includes(`PAGEEND${token}`), `page ${page}: its tail follows the omission`)
  }

  // What the model actually received: the fixture logs counts only.
  const logs = compose(['logs', '--no-log-prefix', 'contract-model']).stdout
  const sent = JSON.parse(logs.split('\n').filter((line) => line.startsWith('SUGGEST ')).at(-1).slice('SUGGEST '.length))
  console.log('model received: ' + JSON.stringify({ ...sent, starts: sent.starts.length, ends: sent.ends.length }))
  const all = Array.from({ length: PAGES }, (_, index) => String(index + 1).padStart(2, '0'))
  assert.equal(sent.everyPage, true, 'the prompt header claims every physical page')
  assert.deepEqual(sent.starts, all, 'every page head reached the model')
  assert.deepEqual(sent.ends, all, 'every page tail reached the model')
  assert.equal(sent.omittedMarks, PAGES, 'each page was cut once')
  assert.equal(sent.nordic, true, 'æøå survived the byte-to-character conversion')
})

test('durability: research state survives a normal restart', { timeout: 900_000 }, async () => {
  compose(['down'])
  compose(['up', '-d', '--wait'])
  await waitForHealth()

  // The entrypoint replayed migrations against the already-current database.
  const fresh = new Session()
  await fresh.login()
  const projects = await fresh.api('/project-contexts')
  assert.ok(
    projects.body.projectContexts.some(
      (project) => project.projectContextId === state.projectId,
    ),
    'project survived restart',
  )
  const extraction = await fresh.api(`/extractions/${state.extractionId}`)
  assert.equal(extraction.status, 200)
  assert.equal(extraction.body.extraction.outcome, 'SUCCEEDED')
  assert.ok(extraction.body.extraction.reviewDecisions.length > 0)
})

test('projects: permanent deletion removes the owned graph', async () => {
  const fresh = new Session()
  await fresh.login()
  const deleted = await fresh.api(`/project-contexts/${state.projectId}`, {
    method: 'DELETE',
  })
  assert.equal(deleted.status, 204)
  const extraction = await fresh.api(`/extractions/${state.extractionId}`)
  assert.equal(extraction.status, 404)
})

test('garbage collection: a sweep after deletion runs every phase', { timeout: 120_000 }, () => {
  assert.deepEqual(collectGarbageNow().summary.failedPhases, [])
})

after(() => {
  // The contract suite owns its isolated Compose project and disposable volume.
  compose(['down', '--volumes'], { allowFailure: true })
})
