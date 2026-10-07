// OCR result reuse through Studio, against a real OCR server behind a counting proxy (opt-in: skipped unless a
// real OCR server, an extraction model and a scanned PDF are named). A scanned PDF uploaded into a second project, or
// reprocessed back to an earlier layout, adopts the earlier run's result without one OCR request; a new recipe
// (spreads) runs OCR; adopted runs survive their donors' deletion.
//   FREE_REAL_OCR_URL=http://<ocr_model>:8000/v1/chat/completions FREE_REAL_EXTRACT_URL=… FREE_REAL_EXTRACT_MODEL=… \
//   FREE_REAL_OCR_REUSE_PDF=<an image-only, black-and-white scan: the spreads ingest refuses colour> \
//   pnpm --filter studio exec playwright test --config playwright.service.config.ts real-service-reuse.spec.ts
// No extraction runs; the extraction variables only make the service harness route OCR to FREE_REAL_OCR_URL.
import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createServer, request as forwardRequest } from 'node:http'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { sourceIngestionAdmittedSchema } from '../shared/sourceDocumentIngestion.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { startRealService } from './realService.js'
import { settle } from './sourceIngestion.js'

const headers = { Origin: E2E_ORIGIN }

async function ocrProxy(upstream: string) {
  const target = new URL(upstream)
  const counts = { completions: 0, other: 0 }
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/chat/completions')) counts.completions++
    else counts.other++
    const forward = forwardRequest({ host: target.hostname, port: target.port, path: request.url, method: request.method,
      headers: { ...request.headers, host: target.host } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    forward.on('error', (error) => { response.writeHead(502); response.end(String(error)) })
    request.pipe(forward)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, counts: () => ({ ...counts }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function project(page: Page, name: string) {
  const response = await page.request.post('/api/project-contexts', { headers, data: { name } })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).projectContext.projectContextId as string
}

async function upload(page: Page, projectId: string, pdf: Buffer, layout: 'pages' | 'spreads') {
  const response = await page.request.post(`/api/project-contexts/${projectId}/source-documents`, {
    headers, timeout: 900_000,
    multipart: { file: { name: 'scan.pdf', mimeType: 'application/pdf', buffer: pdf }, layout } })
  expect(response.status(), await response.text()).toBe(202)
  const row = await settle(page, projectId, sourceIngestionAdmittedSchema.parse(await response.json()).workflowId, 900_000)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'succeeded' })
  return (row as { sourceDocumentId: string }).sourceDocumentId
}

async function head(page: Page, projectId: string, documentId: string) {
  const response = await page.request.get(`/api/project-contexts/${projectId}/source-documents/${documentId}/reopen`)
  expect(response.ok(), await response.text()).toBeTruthy()
  const reopen = documentReopenResponseSchema.parse(await response.json())
  const canonical = await page.request.get(reopen.sourceRepresentation.resources.parsedDocumentUrl)
  expect(canonical.ok(), await canonical.text()).toBeTruthy()
  const body = await canonical.json()
  return { representationId: reopen.sourceRepresentation.sourceRepresentationId, runId: body.document.document_id as string,
    anchors: body.evidence_index.anchors.length as number }
}

async function reprocess(page: Page, projectId: string, documentId: string, layout: 'pages' | 'spreads') {
  const { representationId } = await head(page, projectId, documentId)
  const response = await page.request.post(`/api/project-contexts/${projectId}/source-documents/${documentId}/reprocess`, {
    headers, timeout: 900_000, data: { requestKey: randomUUID(), expectedRepresentationId: representationId, layout } })
  expect(response.status(), await response.text()).toBe(201)
}

async function markdown(runs: string, runId: string) {
  const directory = join(runs, runId, 'result', 'pages')
  const names = (await readdir(directory)).filter((name) => /^\d+\.json$/.test(name)).sort()
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')).markdown as string))
}

async function files(root: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...await files(path))
    else out.push(path)
  }
  return out
}

test('a scanned PDF parsed again with the same recipe adopts the earlier result with no OCR request', async ({ page }, info) => {
  const upstream = process.env.FREE_REAL_OCR_URL
  test.skip(!upstream || !process.env.FREE_REAL_EXTRACT_URL || !process.env.FREE_REAL_OCR_REUSE_PDF,
    'Needs a real OCR server, an extraction model and a scanned PDF.')
  test.setTimeout(3_600_000)
  const pdf = await readFile(process.env.FREE_REAL_OCR_REUSE_PDF!)
  const proxy = await ocrProxy(upstream!)
  process.env.FREE_REAL_OCR_URL = proxy.url  // read by startRealService: the worker's OCR requests go through the proxy
  const service = await startRealService(info.outputPath('parsing-service.log'))
  const evidence: Record<string, unknown> = {}
  const record = async (step: string, value: unknown) => {
    evidence[step] = value
    await info.attach(step, { body: JSON.stringify(value, null, 2), contentType: 'application/json' })
  }
  const manifest = async (runId: string) => (await fetch(`${service.url}/api/runs/${runId}/result`)).json()
  try {
    await loginResearcher(page)
    const first = await project(page, 'Reuse donor')
    const second = await project(page, 'Reuse adopter')
    const third = await project(page, 'Reuse spreads adopter')

    // 1. First parse of the scan: real OCR.
    let started = Date.now()
    const donorDoc = await upload(page, first, pdf, 'pages')
    const donor = await head(page, first, donorDoc)
    const afterDonor = proxy.counts()
    const donorManifest = await manifest(donor.runId)
    await record('1-donor-pages', { seconds: (Date.now() - started) / 1000, ocr: afterDonor, run: donor, manifest: donorManifest })
    expect(afterDonor.completions).toBeGreaterThan(0)
    expect(donorManifest.reused_from).toBeUndefined()

    // 2. Same bytes, same layout, another project: adopted, zero OCR requests (not even the server probe).
    started = Date.now()
    const adopterDoc = await upload(page, second, pdf, 'pages')
    const adopter = await head(page, second, adopterDoc)
    const afterAdopter = proxy.counts()
    const adopterManifest = await manifest(adopter.runId)
    await record('2-adopter-pages', { seconds: (Date.now() - started) / 1000, ocr: afterAdopter, run: adopter, manifest: adopterManifest })
    expect(afterAdopter).toEqual(afterDonor)
    expect(adopter.runId).not.toBe(donor.runId)
    expect(adopterManifest.reused_from).toEqual({ run_id: donor.runId, generation: donorManifest.generation })
    expect(adopterManifest.fingerprint).toBe(donorManifest.fingerprint)
    expect(adopterManifest.generation).not.toBe(donorManifest.generation)
    expect(adopterManifest.page_count).toBe(donorManifest.page_count)
    expect(adopter.anchors).toBe(donor.anchors)
    expect(await markdown(service.runs, adopter.runId)).toEqual(await markdown(service.runs, donor.runId))

    // 3. A new recipe (spreads → ingest) is not reused: it OCRs.
    started = Date.now()
    await reprocess(page, second, adopterDoc, 'spreads')
    const spreads = await head(page, second, adopterDoc)
    const afterSpreads = proxy.counts()
    const spreadsManifest = await manifest(spreads.runId)
    await record('3-reprocess-spreads', { seconds: (Date.now() - started) / 1000, ocr: afterSpreads, run: spreads, manifest: spreadsManifest })
    expect(afterSpreads.completions).toBeGreaterThan(afterAdopter.completions)
    expect(spreadsManifest.reused_from).toBeUndefined()
    expect(spreadsManifest.fingerprint).not.toBe(donorManifest.fingerprint)

    // 4. Spreads of the same bytes in a third project: ingest seeded (hard links) and result adopted, no OCR.
    started = Date.now()
    const spreadsDoc = await upload(page, third, pdf, 'spreads')
    const spreadsAdopter = await head(page, third, spreadsDoc)
    const afterSpreadsAdopter = proxy.counts()
    const spreadsAdopterManifest = await manifest(spreadsAdopter.runId)
    const ingestFiles = (await files(join(service.runs, spreadsAdopter.runId))).filter((path) => path.includes('/ingest/'))
    const links = await Promise.all(ingestFiles.map(async (path) => ({ path: path.slice(service.runs.length), nlink: (await stat(path)).nlink })))
    await record('4-adopter-spreads', { seconds: (Date.now() - started) / 1000, ocr: afterSpreadsAdopter, run: spreadsAdopter,
      manifest: spreadsAdopterManifest, ingestLinks: links })
    expect(afterSpreadsAdopter).toEqual(afterSpreads)
    expect(spreadsAdopterManifest.reused_from).toEqual({ run_id: spreads.runId, generation: spreadsManifest.generation })
    expect(links.some((link) => link.nlink >= 2)).toBe(true)
    expect(await markdown(service.runs, spreadsAdopter.runId)).toEqual(await markdown(service.runs, spreads.runId))

    // 5. Reprocess back to pages (the original motivation): adopted, no OCR.
    started = Date.now()
    await reprocess(page, second, adopterDoc, 'pages')
    const back = await head(page, second, adopterDoc)
    const afterBack = proxy.counts()
    const backManifest = await manifest(back.runId)
    await record('5-reprocess-back-to-pages', { seconds: (Date.now() - started) / 1000, ocr: afterBack, run: back, manifest: backManifest })
    expect(afterBack).toEqual(afterSpreads)
    expect(backManifest.fingerprint).toBe(donorManifest.fingerprint)
    expect(backManifest.reused_from?.run_id).toBeDefined()

    // 6. Donors deleted from disk, service restarted: adopted runs still serve their results and canonical packages.
    await rm(join(service.runs, donor.runId), { recursive: true, force: true })
    await rm(join(service.runs, spreads.runId), { recursive: true, force: true })
    await service.restart()
    const survivors = []
    for (const [projectId, documentId, runId] of [[third, spreadsDoc, spreadsAdopter.runId], [second, adopterDoc, back.runId]]) {
      const response = await fetch(`${service.url}/api/runs/${runId}/result`)
      expect(response.status).toBe(200)
      const reopened = await head(page, projectId, documentId)
      expect(reopened.runId).toBe(runId)
      expect(reopened.anchors).toBeGreaterThan(0)
      survivors.push({ runId, status: response.status, anchors: reopened.anchors })
    }
    await record('6-donors-deleted', { survivors, ocr: proxy.counts() })
    expect(proxy.counts()).toEqual(afterSpreads)
  } finally {
    await info.attach('evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
    await service.close()
    await proxy.close()
    process.env.FREE_REAL_OCR_URL = upstream
  }
})
