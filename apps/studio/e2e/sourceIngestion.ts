import { expect, type Page } from '@playwright/test'
import {
  sourceIngestionAdmittedSchema,
  sourceIngestionListingSchema,
  type SourceIngestion,
} from '../shared/sourceDocumentIngestion.contract.js'
import { E2E_ORIGIN } from './auth.js'

const headers = { Origin: E2E_ORIGIN }

function post(page: Page, project: string, pdf: Buffer, name: string) {
  return page.request.post(`/api/project-contexts/${project}/source-documents`, {
    headers, multipart: { file: { name, mimeType: 'application/pdf', buffer: pdf } },
  })
}

/** Sends one PDF and returns the workflow Studio admitted it as (202). */
export async function admit(page: Page, project: string, pdf: Buffer, name = 'source.pdf'): Promise<string> {
  const response = await post(page, project, pdf, name)
  expect(response.status(), await response.text()).toBe(202)
  return sourceIngestionAdmittedSchema.parse(await response.json()).workflowId
}

/** Waits, through the Source Ingestion listing, until the attempt succeeded or failed, and returns that row. */
export async function settle(page: Page, project: string, workflowId: string, timeout = 300_000): Promise<SourceIngestion> {
  let settled: SourceIngestion | undefined
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/project-contexts/${project}/source-ingestions?workflowId=${encodeURIComponent(workflowId)}`)
    expect(response.ok(), await response.text()).toBeTruthy()
    const row = sourceIngestionListingSchema.parse(await response.json()).ingestions.find((ingestion) => ingestion.workflowId === workflowId)
    settled = row && (row.status === 'succeeded' || row.status === 'failed') ? row : undefined
    return settled?.status ?? row?.status ?? 'absent'
  }, { timeout, intervals: [250, 500, 1000] }).toMatch(/^(succeeded|failed)$/)
  return settled!
}

/** The Source Document an upload became: at once for content Studio already holds (201), or once its attempt succeeded. */
export async function uploaded(page: Page, project: string, pdf: Buffer, name = 'source.pdf'): Promise<{ sourceDocumentId: string }> {
  const response = await post(page, project, pdf, name)
  if (response.status() === 201) return (await response.json()) as { sourceDocumentId: string }
  expect(response.status(), await response.text()).toBe(202)
  const row = await settle(page, project, sourceIngestionAdmittedSchema.parse(await response.json()).workflowId)
  expect(row, JSON.stringify(row)).toMatchObject({ status: 'succeeded' })
  return { sourceDocumentId: (row as Extract<SourceIngestion, { status: 'succeeded' }>).sourceDocumentId }
}
