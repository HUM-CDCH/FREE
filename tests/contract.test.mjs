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
