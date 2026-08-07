import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './prisma/db.js'

const examplesDirectory = fileURLToPath(new URL('../../../examples/', import.meta.url))

/** The same override Studio uses for the browser and its artifact routes. */
const parsingService =
  process.env['VITE_PARSING_SERVICE_URL'] ?? 'http://127.0.0.1:8000'
const contractVersion = 'parsed_document.v2'

export const exampleProjects = [
  {
    projectContextId: '51000000-0000-4000-8000-000000000001',
    name: 'Ellekilde, TAK 1355',
    documents: [
      {
        sourceDocumentId: '51000000-0000-4000-8001-000000000001',
        sourceRepresentationId: '51000000-0000-4000-8002-000000000001',
        filename: 'Beretning_Ellekilde_8_13.pdf',
      },
    ],
  },
  {
    projectContextId: '51000000-0000-4000-8000-000000000002',
    name: 'Test documents',
    documents: [
      {
        sourceDocumentId: '51000000-0000-4000-8001-000000000002',
        sourceRepresentationId: '51000000-0000-4000-8002-000000000002',
        filename: '1790-06-17-1.pdf',
      },
      {
        sourceDocumentId: '51000000-0000-4000-8001-000000000003',
        sourceRepresentationId: '51000000-0000-4000-8002-000000000003',
        filename:
          'Zhang et al. 2024 - Properties of skin collagen from southern catfish (Silurus meridionalis) fed with raw and cooked food.pdf',
      },
    ],
  },
] as const

/** Everything one immutable Source Representation Revision pins. */
export type IngestedRepresentation = {
  artifactReference: string
  artifactSha256: string
  contractVersion: string
  preprocessId: string
  parserName: string
  parserVersion: string
}
export type Ingest = (
  pdf: Uint8Array,
  filename: string,
) => Promise<IngestedRepresentation>

type SeedDatabase = Pick<typeof db, 'orm'>

async function parsingServiceRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(`${parsingService}${path}`, init)
  if (!response.ok)
    throw new Error(`Parsing Service ${path} failed with HTTP ${response.status}.`)
  return response
}

/** The seed cannot invent artifact provenance, so a missing field is fatal. */
function required(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error(`The parsed document is missing ${what}.`)
  return value
}

async function awaitCompletedTask(taskId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = (await (
      await parsingServiceRequest(`/tasks/${taskId}`)
    ).json()) as { status?: unknown; error_code?: unknown }
    if (task.status === 'completed') return
    if (task.status === 'failed')
      throw new Error(
        `Parsing failed: ${String(task.error_code ?? 'unknown error')}.`,
      )
    if (Date.now() > deadline)
      throw new Error(`Parsing did not finish within ${timeoutMs}ms.`)
    await new Promise((wake) => setTimeout(wake, 1000))
  }
}

/**
 * Ingest through the Parsing Service so a seeded Source Document owns exactly the
 * retained artifacts an uploaded one would, and reopening has one path. Identical
 * bytes hit the service's canonical cache, so re-seeding never re-runs the parsers.
 */
export const ingestThroughParsingService: Ingest = async (pdf, filename) => {
  const form = new FormData()
  // Copied because a Buffer may be a view into a pooled, shared ArrayBuffer.
  form.append(
    'file',
    new Blob([Uint8Array.from(pdf)], { type: 'application/pdf' }),
    filename,
  )
  const created = (await (
    await parsingServiceRequest('/tasks', { method: 'POST', body: form })
  ).json()) as { task_id?: unknown }
  const taskId = required(created.task_id, 'a task identity')

  await awaitCompletedTask(taskId, 10 * 60 * 1000)

  // Hashed as served: this is the validator the artifact routes revalidate with.
  const body = await (
    await parsingServiceRequest(`/tasks/${taskId}/document`)
  ).text()
  const document = JSON.parse(body) as {
    schema_version?: unknown
    preprocessing?: { preprocess_id?: unknown }
    arbitration?: { primary_document_parser?: unknown }
    parser_runs?: Array<{ parser?: unknown; version?: unknown }>
  }
  const parserName = required(
    document.arbitration?.primary_document_parser,
    'its primary document parser',
  )
  const parserVersion = document.parser_runs?.find(
    (run) => run.parser === parserName,
  )?.version
  const parsedContractVersion = required(
    document.schema_version,
    'a contract version',
  )
  if (parsedContractVersion !== contractVersion)
    throw new Error(`The parsed document is not ${contractVersion}.`)
  return {
    artifactReference: taskId,
    artifactSha256: createHash('sha256').update(body).digest('hex'),
    contractVersion: parsedContractVersion,
    preprocessId: required(
      document.preprocessing?.preprocess_id,
      'a preprocessing identity',
    ),
    parserName,
    parserVersion: typeof parserVersion === 'string' ? parserVersion : 'unknown',
  }
}

export async function parsingServiceReachable(): Promise<boolean> {
  try {
    return (await parsingServiceRequest('/status')).ok
  } catch {
    return false
  }
}

/**
 * Seeds the example Project Contexts, their Source Documents, and — when an
 * `ingest` is supplied — the Source Representation Revision each one reopens
 * from. Fixed identities make re-seeding idempotent.
 */
export async function seedExampleProjects(
  database: SeedDatabase = db,
  ingest: Ingest | null = ingestThroughParsingService,
) {
  let projectsCreated = 0
  let documentsCreated = 0
  let representationsCreated = 0
  // Each example is independent, so one unparseable PDF must not cost the others
  // their artifacts. The Source Document still exists; only reopening is missing.
  const representationFailures: Array<{ filename: string; reason: string }> = []

  for (const project of exampleProjects) {
    const existingProject = await database.orm.public.ProjectContext.first({
      id: project.projectContextId,
    })
    if (!existingProject) {
      await database.orm.public.ProjectContext.create({
        id: project.projectContextId,
        name: project.name,
      })
      projectsCreated += 1
    }

    for (const document of project.documents) {
      const pdf = await readFile(resolve(examplesDirectory, document.filename))
      const existingDocument = await database.orm.public.SourceDocument.first({
        id: document.sourceDocumentId,
      })
      if (!existingDocument) {
        await database.orm.public.SourceDocument.create({
          id: document.sourceDocumentId,
          projectContextId: project.projectContextId,
          contentSha256: createHash('sha256').update(pdf).digest('hex'),
          mediaType: 'application/pdf',
          originalName: basename(document.filename),
        })
        documentsCreated += 1
      }

      if (!ingest) continue
      const existingRepresentation =
        await database.orm.public.SourceRepresentationRevision.first({
          id: document.sourceRepresentationId,
        })
      if (existingRepresentation) continue
      try {
        const representation = {
          id: document.sourceRepresentationId,
          sourceDocumentId: document.sourceDocumentId,
          revisionNumber: 1,
          ...(await ingest(pdf, basename(document.filename))),
        }
        await database.orm.public.SourceRepresentationRevision.create(
          representation,
        )
        representationsCreated += 1
      } catch (cause) {
        representationFailures.push({
          filename: basename(document.filename),
          reason: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
  }

  return {
    projectsCreated,
    documentsCreated,
    representationsCreated,
    representationFailures,
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const reachable = await parsingServiceReachable()
    if (!reachable)
      console.warn(
        `The Parsing Service is not reachable at ${parsingService}, so the example Source Documents will have no retained artifacts and cannot be reopened. Start it with \`pnpm --filter parsing-service dev\` and re-run \`pnpm db:seed\`.`,
      )
    const result = await seedExampleProjects(
      db,
      reachable ? ingestThroughParsingService : null,
    )
    for (const failure of result.representationFailures)
      console.warn(
        `Could not retain artifacts for ${failure.filename}, so it cannot be reopened: ${failure.reason}`,
      )
    console.log(
      `Seeded example PDFs: ${result.projectsCreated} projects, ${result.documentsCreated} Source Documents, and ${result.representationsCreated} Source Representations created${
        result.representationFailures.length > 0
          ? `, ${result.representationFailures.length} not ingested`
          : ''
      }.`,
    )
  } finally {
    await db.close()
  }
}
