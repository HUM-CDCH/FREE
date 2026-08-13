import {
  ApiError,
  boundedLimit,
  noStoreError,
  json,
  noStore,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import {
  createProjectStore,
  type ProjectStore,
} from '../../../packages/db/src/project-store.js'
import {
  canonicalPackageStore,
  type CanonicalArtifactRead,
  type CanonicalPackageDescriptor,
} from '../../../packages/db/src/artifact-store.js'
import {
  canonicalUuidSchema,
  projectContextNameLimit,
  projectContextWriteRequestSchema,
} from '../shared/projectContext.contract.js'
import { decodeParsedDocument } from '../shared/parsedDocument.js'

type ProjectContextReadStore = Pick<
  ProjectStore,
  'listProjectContexts' | 'getProjectContextWithDocuments'
> &
  Partial<
    Pick<ProjectStore, 'getDocumentReopenSnapshot' | 'getSourceRepresentation'>
  >
type ReadArtifact = (
  descriptor: CanonicalPackageDescriptor,
  artifact: 'source',
) => Promise<CanonicalArtifactRead>

async function sourceDocumentPageCount(
  store: ProjectContextReadStore,
  readArtifact: ReadArtifact,
  projectContextId: string,
  sourceDocumentId: string,
): Promise<number | null> {
  if (!store.getDocumentReopenSnapshot || !store.getSourceRepresentation)
    return null
  try {
    const snapshot = await store.getDocumentReopenSnapshot(
      projectContextId,
      sourceDocumentId,
    )
    if (!snapshot) return null
    const descriptor = await store.getSourceRepresentation(
      snapshot.sourceRepresentation.sourceRepresentationId,
    )
    if (!descriptor) return null
    const artifact = await readArtifact(descriptor, 'source')
    return decodeParsedDocument(
      JSON.parse(new TextDecoder().decode(artifact.bytes)) as unknown,
    ).page_count
  } catch {
    return null
  }
}

/** Best-effort removal of one package the deletion left unreferenced. */
export type RemovePackage = (
  descriptor: CanonicalPackageDescriptor,
  isReferenced: () => Promise<boolean>,
) => Promise<void>

function projectId(pathname: string): string | null {
  const match = /^\/api\/project-contexts\/([^/]+)$/.exec(pathname)
  return match?.[1] ?? null
}

/** The one place a pathname identity becomes a validated Project Context id. */
function validProjectId(id: string): string {
  if (!canonicalUuidSchema.safeParse(id).success)
    throw new ApiError(
      422,
      'invalid_request',
      'projectContextId must be a canonical lowercase UUID.',
    )
  return id
}

/** A parameterized write names exactly one Project Context. */
function selectedProjectId(url: URL): string {
  const id = projectId(url.pathname)
  if (id === null)
    throw new ApiError(404, 'not_found', 'Project Context route was not found.')
  return validProjectId(id)
}

async function requestedName(request: Request): Promise<string> {
  const parsed = projectContextWriteRequestSchema.safeParse(
    await parseJsonRequest(request),
  )
  if (!parsed.success)
    throw new ApiError(
      422,
      'invalid_request',
      `name must be 1 to ${projectContextNameLimit} characters after trimming.`,
    )
  return parsed.data.name
}

const removePackage: RemovePackage = async (descriptor, isReferenced) => {
  // Relational deletion already succeeded, so a stranded canonical package is
  // a warning, never a failed deletion.
  await canonicalPackageStore
    .remove(descriptor, isReferenced)
    .catch((cause: unknown) => {
      console.warn(
        `Could not remove the unreferenced canonical package ${descriptor.artifactReference}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    })
}

/** Shared packages are removed only when no surviving revision references them. */
async function removeUnreferenced(
  store: Pick<ProjectStore, 'isPackageReferenced'>,
  candidates: readonly CanonicalPackageDescriptor[],
  remove: RemovePackage,
): Promise<void> {
  const asked = new Set<string>()
  for (const descriptor of candidates) {
    if (asked.has(descriptor.artifactReference)) continue
    asked.add(descriptor.artifactReference)
    const isReferenced = () =>
      store.isPackageReferenced(descriptor.artifactReference).catch((cause: unknown) => {
        console.warn(
          `Could not check whether the canonical package ${descriptor.artifactReference} is still referenced, so it is retained: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        )
        return true
      })
    if (!(await isReferenced())) await remove(descriptor, isReferenced)
  }
}

export function createGetProjectContexts(
  store: ProjectContextReadStore = createProjectStore(),
  readArtifact: ReadArtifact = canonicalPackageStore.read,
) {
  return async function getProjectContexts(
    request: Request,
  ): Promise<Response> {
    try {
      const url = new URL(request.url)
      const id = projectId(url.pathname)
      if (id === null) {
        const projectContexts = await store
          .listProjectContexts(boundedLimit(url))
          .catch((cause) => {
            throw persistenceUnavailable(cause)
          })
        return json({ projectContexts }, { headers: noStore })
      }
      const projectContext = await store
        .getProjectContextWithDocuments(validProjectId(id))
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!projectContext)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      const sourceDocuments = await Promise.all(
        projectContext.sourceDocuments.map(async (document) => ({
          ...document,
          pageCount: await sourceDocumentPageCount(
            store,
            readArtifact,
            id,
            document.sourceDocumentId,
          ),
        })),
      )
      return json(
        { projectContext: projectContext.projectContext, sourceDocuments },
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createProjectContextWrites(
  store: Pick<
    ProjectStore,
    | 'createProjectContext'
    | 'renameProjectContext'
    | 'deleteProjectContext'
    | 'isPackageReferenced'
  > = createProjectStore(),
  remove: RemovePackage = removePackage,
) {
  const POST = async (request: Request): Promise<Response> => {
    try {
      if (new URL(request.url).pathname !== '/api/project-contexts')
        throw new ApiError(
          404,
          'not_found',
          'Project Context route was not found.',
        )
      const name = await requestedName(request)
      const projectContext = await store
        .createProjectContext(name)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      return json({ projectContext }, { status: 201, headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }

  const PATCH = async (request: Request): Promise<Response> => {
    try {
      const id = selectedProjectId(new URL(request.url))
      const name = await requestedName(request)
      const projectContext = await store
        .renameProjectContext(id, name)
        .catch((cause) => {
          throw persistenceUnavailable(cause)
        })
      if (!projectContext)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      return json({ projectContext }, { headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }

  const DELETE = async (request: Request): Promise<Response> => {
    try {
      const id = selectedProjectId(new URL(request.url))
      const candidates = await store.deleteProjectContext(id).catch((cause) => {
        throw persistenceUnavailable(cause)
      })
      if (!candidates)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      await removeUnreferenced(store, candidates, remove)
      return new Response(null, { status: 204, headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { POST, PATCH, DELETE }
}

export const GET = createGetProjectContexts()
export const { POST, PATCH, DELETE } = createProjectContextWrites()
