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
  PROJECT_CONTEXT_NAME_LIMIT,
  type ResearcherProjectStore,
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
import { cancelScopeWork } from './_scope_cancellation.js'
import { decodeParsedDocument } from 'extraction/parsed-document'

type ProjectContextReadStore = Pick<
  ResearcherProjectStore,
  'listProjectContexts' | 'getProjectContextWithDocuments'
> &
  Partial<
    Pick<
      ResearcherProjectStore,
      | 'getDocumentReopenSnapshot'
      | 'getSourceRepresentation'
      | 'listRecentActivity'
    >
  >

/** The home page shows the latest events; the read stays small and bounded. */
const RECENT_ACTIVITY_LIMIT = 5
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
      projectContextId,
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

if (projectContextNameLimit !== PROJECT_CONTEXT_NAME_LIMIT)
  throw new Error('Project Context name limits must match.')

export function createGetProjectContexts(
  store: ProjectContextReadStore,
  readArtifact: ReadArtifact = canonicalPackageStore.read,
) {
  return async function getProjectContexts(
    request: Request,
  ): Promise<Response> {
    try {
      const url = new URL(request.url)
      const id = projectId(url.pathname)
      if (id === null) {
        const [projectContexts, recentActivity] = await Promise.all([
          store.listProjectContexts(boundedLimit(url)),
          store.listRecentActivity?.(RECENT_ACTIVITY_LIMIT) ?? [],
        ]).catch((cause) => {
          throw persistenceUnavailable(cause)
        })
        return json({ projectContexts, recentActivity }, { headers: noStore })
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
    ResearcherProjectStore,
    'createProjectContext' | 'renameProjectContext' | 'deleteProjectContext'
  >,
  cancelWork: typeof cancelScopeWork = cancelScopeWork,
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
      const deleted = await store.deleteProjectContext(id).catch((cause) => {
        throw persistenceUnavailable(cause)
      })
      if (!deleted)
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      await cancelWork({ projectContextId: id }).catch(() => {
        console.warn('Could not stop all Project Context work after deletion; garbage collection will retry.')
      })
      return new Response(null, { status: 204, headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { POST, PATCH, DELETE }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return {
    GET: createGetProjectContexts(store),
    ...createProjectContextWrites(store),
  }
}
