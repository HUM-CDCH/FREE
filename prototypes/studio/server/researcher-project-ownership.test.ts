import {
  emptyProjectContextActivitySummary,
  type DocumentReopenSnapshot,
  type ResearcherAccountRecord,
  type ResearcherAccountStore,
  type ResearcherProjectStore,
} from 'db'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { ExtractionError, type ExtractionModule } from 'extraction'
import parsedDocument from '../src/assets/parsed_document.v2.json'
import {
  createGetProjectContexts,
  createProjectContextWrites,
} from '../api/project_contexts.js'
import {
  createSourceDocumentDeletion,
  createSourceDocumentIngestion,
} from '../api/source_documents.js'
import { createSourceRepresentationResource } from '../api/source_representations.js'
import {
  createGetExtractionSchemas,
  createPatchExtractionSchema,
} from '../api/extraction_schemas.js'
import { createSchemaRevisionHandlers } from '../api/schema_revisions.js'
import { createPostGenerateSchema } from '../api/generate_schema.js'
import { createPostEditSchema } from '../api/edit_schema.js'
import { createPostChat } from '../api/chat.js'
import {
  createResearcherApiHandlers as createDocumentReopenHandlers,
} from '../api/document_reopen.js'
import {
  createResearcherApiHandlers as createExtractionHandlers,
} from '../api/extractions.js'
import {
  createResearcherApiHandlers as createBatchExtractionHandlers,
} from '../api/batch_extractions.js'
import {
  createResearcherApiHandlers as createBatchSuggestionHandlers,
} from '../api/batch_schema_suggestions.js'
import {
  createApiDispatcher,
  createApiHandlerRegistry,
  type ResearcherApiHandlerFactory,
} from './api-dispatcher.js'
import { createStudioApp, type StudioApp } from './app.js'
import {
  createInMemoryEntraIdentityProvider,
  type InMemoryEntraIdentityProvider,
} from '../test/support/inMemoryEntraIdentityProvider.js'

const extractionRuntimeMock = vi.hoisted(() => ({
  modules: new Map<string, unknown>(),
}))
const operationKickMock = vi.hoisted(() => vi.fn())

vi.mock('../api/_extraction_runtime.js', () => ({
  createResearcherExtractions(researcherAccountId: string) {
    const module = extractionRuntimeMock.modules.get(researcherAccountId)
    if (!module)
      throw new Error(
        `No test ExtractionModule for ${researcherAccountId}.`,
      )
    return module
  },
}))
vi.mock('../api/_project_operations.js', () => ({
  projectOperations: { kick: operationKickMock },
}))

const ORIGIN = 'https://studio.example'
const SECRET = Buffer.alloc(32, 17)
const CLIENT = { clientAddress: '192.0.2.45' }
const CREATED_AT = new Date('2026-08-20T10:00:00.000Z')
const TENANT_ID = '30000000-0000-4000-8000-000000000001'

const ids = {
  accountA: '10000000-0000-4000-8000-000000000001',
  accountB: '20000000-0000-4000-8000-000000000001',
  projectA: '11000000-0000-4000-8000-000000000001',
  projectB: '21000000-0000-4000-8000-000000000001',
  createdProjectA: '11000000-0000-4000-8000-000000000002',
  documentA: '11000000-0000-4001-8000-000000000001',
  documentB: '21000000-0000-4001-8000-000000000001',
  representationA: '11000000-0000-4002-8000-000000000001',
  representationB: '21000000-0000-4002-8000-000000000001',
  annotationA: '11000000-0000-4003-8000-000000000001',
  annotationB: '21000000-0000-4003-8000-000000000001',
  schemaA: '11000000-0000-4004-8000-000000000001',
  schemaB: '21000000-0000-4004-8000-000000000001',
  revisionA: '11000000-0000-4005-8000-000000000001',
  revisionB: '21000000-0000-4005-8000-000000000001',
  extractionA: '11000000-0000-4006-8000-000000000001',
  extractionB: '21000000-0000-4006-8000-000000000001',
  batchA: '11000000-0000-4007-8000-000000000001',
  batchB: '21000000-0000-4007-8000-000000000001',
  batchSuggestionA: '11000000-0000-4008-8000-000000000001',
  batchSuggestionB: '21000000-0000-4008-8000-000000000001',
  ingestion: '11000000-0000-4009-8000-000000000001',
} as const

const objectIds = {
  [ids.accountA]: '30000000-0000-4000-8000-000000000002',
  [ids.accountB]: '30000000-0000-4000-8000-000000000003',
} as const
const displayNames = {
  [ids.accountA]: 'Alice Researcher',
  [ids.accountB]: 'Bob Researcher',
} as const
const projectNames = {
  [ids.accountA]: 'Alice private project',
  [ids.accountB]: 'Bob private project',
} as const
const sharedDescriptor = {
  artifactReference: 'f'.repeat(64),
  artifactSha256: 'e'.repeat(64),
}
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const sourceBytes = new TextEncoder().encode(JSON.stringify(parsedDocument))
const schemaDefinition = {
  recordDescription: 'One private record.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' as const }],
}

function account(id: keyof typeof objectIds): ResearcherAccountRecord {
  return {
    id,
    tenantId: TENANT_ID,
    objectId: objectIds[id],
    displayName: displayNames[id],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
}

function accountStore(): ResearcherAccountStore {
  const accounts = [account(ids.accountA), account(ids.accountB)]
  return {
    findOrCreate: vi.fn(async (identity) => {
      const existing = accounts.find(
        (candidate) =>
          candidate.tenantId === identity.tenantId &&
          candidate.objectId === identity.objectId,
      )
      if (!existing) throw new Error('Unexpected test Entra identity.')
      existing.displayName = identity.displayName
      existing.updatedAt = new Date()
      return existing
    }),
    findById: vi.fn(async (id) =>
      accounts.find((candidate) => candidate.id === id) ?? null,
    ),
  }
}

type OwnerIds = {
  accountId: typeof ids.accountA | typeof ids.accountB
  projectId: typeof ids.projectA | typeof ids.projectB
  documentId: typeof ids.documentA | typeof ids.documentB
  representationId: typeof ids.representationA | typeof ids.representationB
  annotationId: typeof ids.annotationA | typeof ids.annotationB
  schemaId: typeof ids.schemaA | typeof ids.schemaB
  revisionId: typeof ids.revisionA | typeof ids.revisionB
}

type Relationship = OwnerIds & {
  projectName: string
  documentName: string
  schemaName: string
  projectPresent: boolean
  documentPresent: boolean
}

type ArtifactReader = (
  descriptor: typeof sharedDescriptor,
  artifact: 'pdf' | 'markdown' | 'source',
) => Promise<{ bytes: Uint8Array; mediaType: string }>

type TestPackageStore = {
  save: Mock<
    (
      bytes: Uint8Array,
    ) => Promise<
      typeof sharedDescriptor & { document: unknown; published?: boolean }
    >
  >
  available: Mock<
    (descriptor: typeof sharedDescriptor) => Promise<boolean>
  >
}

type ModelSpies = {
  generateSchema: Mock<() => Promise<never>>
  editSchema: Mock<() => Promise<never>>
  chat: Mock<() => Promise<never>>
}

type ExtractionEffects = {
  singleExecutions: string[]
  reviewMutations: string[]
  cancellations: string[]
  batchExecutions: string[]
  suggestedBatchExecutions: string[]
}

type TwoAccountStores = {
  stores: Map<string, ResearcherProjectStore>
  relationships: Relationship[]
  readArtifact: Mock<ArtifactReader>
  parsingFetch: Mock<typeof fetch>
  packageStore: TestPackageStore
  models: ModelSpies
  extractionModules: Record<string, ExtractionModule>
  extractionEffects: ExtractionEffects
  operationKick: Mock<() => void>
}

function twoAccountStoreFixture(): TwoAccountStores {
  const relationships: Relationship[] = [
    {
      accountId: ids.accountA,
      projectId: ids.projectA,
      documentId: ids.documentA,
      representationId: ids.representationA,
      annotationId: ids.annotationA,
      schemaId: ids.schemaA,
      revisionId: ids.revisionA,
      projectName: projectNames[ids.accountA],
      documentName: 'alice-source.pdf',
      schemaName: 'Alice private schema',
      projectPresent: true,
      documentPresent: true,
    },
    {
      accountId: ids.accountB,
      projectId: ids.projectB,
      documentId: ids.documentB,
      representationId: ids.representationB,
      annotationId: ids.annotationB,
      schemaId: ids.schemaB,
      revisionId: ids.revisionB,
      projectName: projectNames[ids.accountB],
      documentName: 'bob-source.pdf',
      schemaName: 'Bob private schema',
      projectPresent: true,
      documentPresent: true,
    },
  ]
  let packagePresent = true
  const created: Record<string, { projectContextId: string; name: string }[]> = {
    [ids.accountA]: [],
    [ids.accountB]: [],
  }

  const owned = (accountId: string, projectId: string) =>
    relationships.find(
      (relationship) =>
        relationship.accountId === accountId &&
        relationship.projectId === projectId &&
        relationship.projectPresent,
    )

  const reopenSnapshot = (relationship: Relationship): DocumentReopenSnapshot => ({
    projectContext: {
      projectContextId: relationship.projectId,
      name: relationship.projectName,
      createdAt: CREATED_AT,
    },
    sourceDocument: {
      sourceDocumentId: relationship.documentId,
      name: relationship.documentName,
      createdAt: CREATED_AT,
    },
    sourceRepresentation: {
      sourceRepresentationId: relationship.representationId,
      revisionNumber: 1,
      createdAt: CREATED_AT,
    },
    annotationSet: {
      annotationSetId: relationship.annotationId,
      revisionNumber: 1,
      snapshot: [],
    },
    extractionSchema: {
      extractionSchemaId: relationship.schemaId,
      name: 'Private schema',
      schemaRevisionId: relationship.revisionId,
      revisionNumber: 1,
      schemaTree: {
        recordDescription: 'One private record.',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
    },
  })

  const storedRevision = (
    relationship: Relationship,
    schemaTree: unknown = schemaDefinition,
    revisionNumber = 1,
  ) => ({
    schemaRevisionId: relationship.revisionId,
    extractionSchemaId: relationship.schemaId,
    revisionNumber,
    origin:
      revisionNumber === 1
        ? ('suggestion' as const)
        : ('researcher-edit' as const),
    schemaTree,
    createdAt: CREATED_AT,
  })

  const stores = new Map<string, ResearcherProjectStore>()
  for (const accountId of [ids.accountA, ids.accountB] as const) {
    const store: ResearcherProjectStore = {
      researcherAccountId: accountId,
      createProjectContext: vi.fn(async (name) => {
        const projectContextId =
          accountId === ids.accountA
            ? ids.createdProjectA
            : '21000000-0000-4000-8000-000000000002'
        created[accountId].push({ projectContextId, name })
        return { projectContextId, name, createdAt: CREATED_AT }
      }),
      renameProjectContext: vi.fn(async (projectContextId, name) => {
        const relationship = owned(accountId, projectContextId)
        if (!relationship) return null
        relationship.projectName = name
        return { projectContextId, name, createdAt: CREATED_AT }
      }),
      deleteProjectContext: vi.fn(async (projectContextId) => {
        const relationship = owned(accountId, projectContextId)
        if (!relationship) return false
        relationship.projectPresent = false
        relationship.documentPresent = false
        if (
          !relationships.some(
            (candidate) => candidate.documentPresent,
          )
        )
          packagePresent = false
        return true
      }),
      deleteSourceDocument: vi.fn(async (projectContextId, sourceDocumentId) => {
        const relationship = owned(accountId, projectContextId)
        if (
          !relationship ||
          relationship.documentId !== sourceDocumentId ||
          !relationship.documentPresent
        )
          return false
        relationship.documentPresent = false
        if (
          !relationships.some(
            (candidate) => candidate.documentPresent,
          )
        )
          packagePresent = false
        return true
      }),
      listRecentActivity: vi.fn(async () => []),
      listProjectContexts: vi.fn(async () => {
        const projects = relationships
          .filter(
            (relationship) =>
              relationship.accountId === accountId && relationship.projectPresent,
          )
          .map((relationship) => ({
            projectContextId: relationship.projectId,
            name: relationship.projectName,
            createdAt: CREATED_AT,
            sourceDocumentCount: relationship.documentPresent ? 1 : 0,
            summary: emptyProjectContextActivitySummary(CREATED_AT),
          }))
        return [
          ...created[accountId].map((project) => ({
            ...project,
            createdAt: CREATED_AT,
            sourceDocumentCount: 0,
            summary: emptyProjectContextActivitySummary(CREATED_AT),
          })),
          ...projects,
        ]
      }),
      getProjectContextWithDocuments: vi.fn(async (projectContextId) => {
        const relationship = owned(accountId, projectContextId)
        if (!relationship) return null
        return {
          projectContext: {
            projectContextId,
            name: relationship.projectName,
            createdAt: CREATED_AT,
          },
          sourceDocuments: relationship.documentPresent
            ? [
                {
                  sourceDocumentId: relationship.documentId,
                  name: relationship.documentName,
                  createdAt: CREATED_AT,
                },
              ]
            : [],
        }
      }),
      getDocumentReopenSnapshot: vi.fn(
        async (projectContextId, sourceDocumentId, pins) => {
          const relationship = owned(accountId, projectContextId)
          if (
            !relationship ||
            !relationship.documentPresent ||
            relationship.documentId !== sourceDocumentId ||
            (pins !== undefined &&
              (pins.sourceRepresentationRevisionId !==
                relationship.representationId ||
                pins.schemaRevisionId !== relationship.revisionId))
          )
            return null
          return reopenSnapshot(relationship)
        },
      ),
      getSourceRepresentation: vi.fn(
        async (projectContextId, sourceRepresentationId) => {
          const relationship = owned(accountId, projectContextId)
          return relationship?.documentPresent &&
            relationship.representationId === sourceRepresentationId
            ? sharedDescriptor
            : null
        },
      ),
      discardCanonicalPackage: vi.fn(async () => {}),
      ingestSourceDocument: vi.fn(async () => null),
      createBatchSchemaSuggestion: vi.fn(async () => null),
      getBatchSchemaSuggestion: vi.fn(async () => null),
      listBatchSchemaSuggestions: vi.fn(async () => null),
      updateBatchSchemaSuggestionDraft: vi.fn(async () => null),
      retryBatchSchemaSuggestion: vi.fn(async () => null),
      initializeSchemaRevision: vi.fn(async (projectContextId, schemaTree) => {
        const relationship = owned(accountId, projectContextId)
        return relationship
          ? {
              status: 'created' as const,
              revision: storedRevision(relationship, schemaTree),
            }
          : null
      }),
      listExtractionSchemas: vi.fn(async (projectContextId) => {
        const relationship = owned(accountId, projectContextId)
        return relationship
          ? [
              {
                extractionSchemaId: relationship.schemaId,
                name: relationship.schemaName,
                createdAt: CREATED_AT,
                currentRevision: storedRevision(relationship),
              },
            ]
          : null
      }),
      renameExtractionSchema: vi.fn(
        async (projectContextId, extractionSchemaId, name) => {
          const relationship = owned(accountId, projectContextId)
          if (!relationship || relationship.schemaId !== extractionSchemaId)
            return null
          relationship.schemaName = name
          return {
            extractionSchemaId,
            name,
            createdAt: CREATED_AT,
          }
        },
      ),
      appendSchemaRevision: vi.fn(
        async (
          projectContextId,
          extractionSchemaId,
          _expectedRevisionNumber,
          schemaTree,
        ) => {
          const relationship = owned(accountId, projectContextId)
          if (!relationship || relationship.schemaId !== extractionSchemaId)
            return null
          return {
            status: 'created' as const,
            revision: storedRevision(relationship, schemaTree, 2),
          }
        },
      ),
      listSchemaRevisions: vi.fn(
        async (projectContextId, extractionSchemaId) => {
          const relationship = owned(accountId, projectContextId)
          if (!relationship || relationship.schemaId !== extractionSchemaId)
            return null
          return [storedRevision(relationship)]
        },
      ),
      getSchemaRevision: vi.fn(
        async (projectContextId, extractionSchemaId, schemaRevisionId) => {
          const relationship = owned(accountId, projectContextId)
          if (
            !relationship ||
            relationship.schemaId !== extractionSchemaId ||
            relationship.revisionId !== schemaRevisionId
          )
            return null
          return storedRevision(relationship)
        },
      ),
    }
    stores.set(accountId, store)
  }

  const readArtifact = vi.fn(
    async (
      descriptor: typeof sharedDescriptor,
      artifact: 'pdf' | 'markdown' | 'source',
    ) => {
      if (!packagePresent) throw new Error('Physical package was removed.')
      if (
        descriptor.artifactReference !== sharedDescriptor.artifactReference ||
        descriptor.artifactSha256 !== sharedDescriptor.artifactSha256
      )
        throw new Error('Unknown package descriptor.')
      if (artifact === 'source')
        return { bytes: sourceBytes, mediaType: 'application/json' }
      if (artifact === 'markdown')
        return {
          bytes: new TextEncoder().encode('# Shared physical content'),
          mediaType: 'text/markdown; charset=utf-8',
        }
      return { bytes: pdfBytes, mediaType: 'application/pdf' }
    },
  )
  const parsingFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('A cross-owner ingestion must not reach Parsing Service.')
  })
  const packageStore = {
    save: vi.fn(async () => {
      throw new Error('A cross-owner ingestion must not save a package.')
    }),
    available: vi.fn(async () => false),
  }
  const models: ModelSpies = {
    generateSchema: vi.fn(async () => {
      throw new Error('A cross-owner schema suggestion must not execute a model.')
    }),
    editSchema: vi.fn(async () => {
      throw new Error('A cross-owner schema edit must not execute a model.')
    }),
    chat: vi.fn(async () => {
      throw new Error('A cross-owner chat must not execute a model.')
    }),
  }
  const extractionEffects: ExtractionEffects = {
    singleExecutions: [],
    reviewMutations: [],
    cancellations: [],
    batchExecutions: [],
    suggestedBatchExecutions: [],
  }
  const extractionModules: Record<string, ExtractionModule> = {}
  const notFound = () =>
    new ExtractionError('not_found', 'Research resource was not found.')
  for (const accountId of [ids.accountA, ids.accountB] as const) {
    const relationship = relationships.find(
      (candidate) => candidate.accountId === accountId,
    )!
    extractionModules[accountId] = {
      runSingle: vi.fn<ExtractionModule['runSingle']>(async (input) => {
        if (
          input.kind !== 'fresh' ||
          input.sourceRepresentationRevisionId !==
            relationship.representationId ||
          input.schemaRevisionId !== relationship.revisionId
        )
          throw notFound()
        extractionEffects.singleExecutions.push(input.extractionId)
        throw new Error('Authorized Extraction execution is outside this test.')
      }),
      readExtractionAttempt: vi.fn<ExtractionModule['readExtractionAttempt']>(
        async (extractionId) => {
          const ownedExtractionId =
            accountId === ids.accountA ? ids.extractionA : ids.extractionB
          if (extractionId !== ownedExtractionId) return null
          throw new Error('Authorized Extraction read is outside this test.')
        },
      ),
      cancelSingle: vi.fn<ExtractionModule['cancelSingle']>(async (extractionId) => {
        const ownedExtractionId =
          accountId === ids.accountA ? ids.extractionA : ids.extractionB
        if (extractionId !== ownedExtractionId) throw notFound()
        extractionEffects.cancellations.push(extractionId)
        return 'cancellation-requested' as const
      }),
      prepareReview: vi.fn<ExtractionModule['prepareReview']>(async (extractionId) => {
        const ownedExtractionId =
          accountId === ids.accountA ? ids.extractionA : ids.extractionB
        if (extractionId !== ownedExtractionId) throw notFound()
        throw new Error('Authorized Extraction read is outside this test.')
      }),
      readReviewDraft: vi.fn(async () => ({ version: 0, decisions: [] })),
    saveReviewDraft: vi.fn(async (_id, draft) => ({ ...draft, version: draft.version + 1 })),
    finalizeReview: vi.fn<ExtractionModule['finalizeReview']>(async (extractionId) => {
        const ownedExtractionId =
          accountId === ids.accountA ? ids.extractionA : ids.extractionB
        if (extractionId !== ownedExtractionId) throw notFound()
        extractionEffects.reviewMutations.push(extractionId)
        throw new Error('Authorized Extraction review is outside this test.')
      }),
      readDocumentExtractions: vi.fn<ExtractionModule['readDocumentExtractions']>(async (input) => {
        const ownedExtractionId =
          accountId === ids.accountA ? ids.extractionA : ids.extractionB
        if (
          input.sourceDocumentId !== relationship.documentId ||
          (input.extractionId !== undefined &&
            input.extractionId !== ownedExtractionId)
        )
          return null
        throw new Error('Authorized reopen projection is outside this test.')
      }),
      scheduleBatch: vi.fn<ExtractionModule['scheduleBatch']>(async (input) => {
        if (
          input.projectContextId !== relationship.projectId ||
          input.schemaRevisionId !== relationship.revisionId ||
          input.sourceDocumentIds.some(
            (sourceDocumentId) =>
              sourceDocumentId !== relationship.documentId,
          )
        )
          throw notFound()
        extractionEffects.batchExecutions.push(input.projectContextId)
        throw new Error('Authorized Batch execution is outside this test.')
      }),
      scheduleSuggestedBatch: vi.fn<ExtractionModule['scheduleSuggestedBatch']>(async (input) => {
        const ownedSuggestionId =
          accountId === ids.accountA
            ? ids.batchSuggestionA
            : ids.batchSuggestionB
        if (
          input.projectContextId !== relationship.projectId ||
          input.batchSchemaSuggestionId !== ownedSuggestionId
        )
          throw notFound()
        extractionEffects.suggestedBatchExecutions.push(
          input.batchSchemaSuggestionId,
        )
        throw new Error('Authorized suggested Batch is outside this test.')
      }),
      listBatches: vi.fn<ExtractionModule['listBatches']>(async (input) => {
        if (input.projectContextId !== relationship.projectId) throw notFound()
        return []
      }),
      readBatch: vi.fn<ExtractionModule['readBatch']>(async (input) => {
        const ownedBatchId =
          accountId === ids.accountA ? ids.batchA : ids.batchB
        if (
          input.projectContextId !== relationship.projectId ||
          input.batchExtractionId !== ownedBatchId
        )
          throw notFound()
        throw new Error('Authorized Batch read is outside this test.')
      }),
      readBatchResults: vi.fn<ExtractionModule['readBatchResults']>(async (input) => {
        const ownedBatchId =
          accountId === ids.accountA ? ids.batchA : ids.batchB
        if (
          input.projectContextId !== relationship.projectId ||
          input.batchExtractionId !== ownedBatchId
        )
          throw notFound()
        throw new Error('Authorized Batch results are outside this test.')
      }),
    }
  }
  extractionRuntimeMock.modules.clear()
  for (const [accountId, module] of Object.entries(extractionModules))
    extractionRuntimeMock.modules.set(accountId, module)
  operationKickMock.mockClear()

  return {
    stores,
    relationships,
    readArtifact,
    parsingFetch,
    packageStore,
    models,
    extractionModules,
    extractionEffects,
    operationKick: operationKickMock,
  }
}

function researcherModule(factory: ResearcherApiHandlerFactory) {
  return { createResearcherApiHandlers: factory }
}


function ownershipRegistry(fixture: TwoAccountStores) {
  return createApiHandlerRegistry({
    '../api/project_contexts.ts': researcherModule((store) => ({
      GET: createGetProjectContexts(store, fixture.readArtifact),
      ...createProjectContextWrites(store),
    })),
    '../api/source_documents.ts': researcherModule((store) => ({
      POST: createSourceDocumentIngestion(store, {
        fetcher: fixture.parsingFetch,
        packageStore: fixture.packageStore,
      }),
      DELETE: createSourceDocumentDeletion(store),
    })),
    '../api/source_representations.ts': researcherModule((store) => {
      const GET = createSourceRepresentationResource(store, fixture.readArtifact)
      return { GET, HEAD: GET }
    }),
    '../api/extraction_schemas.ts': researcherModule((store) => ({
      GET: createGetExtractionSchemas(store),
      PATCH: createPatchExtractionSchema(store),
    })),
    '../api/schema_revisions.ts': researcherModule((store) =>
      createSchemaRevisionHandlers(store),
    ),
    '../api/generate_schema.ts': researcherModule((store) => ({
      POST: createPostGenerateSchema(
        store,
        { read: fixture.readArtifact },
        fixture.models.generateSchema,
      ),
    })),
    '../api/edit_schema.ts': researcherModule((store) => ({
      POST: createPostEditSchema(
        store,
        { read: fixture.readArtifact },
        fixture.models.editSchema,
      ),
    })),
    '../api/chat.ts': researcherModule((store) => ({
      POST: createPostChat(
        store,
        { read: fixture.readArtifact },
        fixture.models.chat,
      ),
    })),
    '../api/document_reopen.ts': researcherModule(
      createDocumentReopenHandlers,
    ),
    '../api/extractions.ts': researcherModule(createExtractionHandlers),
    '../api/batch_extractions.ts': researcherModule(
      createBatchExtractionHandlers,
    ),
    '../api/batch_schema_suggestions.ts': researcherModule(
      createBatchSuggestionHandlers,
    ),
  })
}

type AppFixture = TwoAccountStores & {
  app: StudioApp
  cookies: Record<typeof ids.accountA | typeof ids.accountB, string>
  createStore: Mock<(accountId: string) => ResearcherProjectStore>
}

function responseCookie(response: Response, name: string): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  const value = values.find((candidate) => candidate.startsWith(`${name}=`))
  if (!value) throw new Error(`Expected a ${name} cookie.`)
  return value.split(';', 1)[0]
}

async function login(
  app: StudioApp,
  identityProvider: InMemoryEntraIdentityProvider,
  objectId: string,
): Promise<string> {
  const accountId =
    objectId === objectIds[ids.accountA]
      ? ids.accountA
      : objectId === objectIds[ids.accountB]
        ? ids.accountB
        : null
  if (accountId === null) throw new Error('Unexpected test Entra identity.')
  identityProvider.selectIdentity({
    tenantId: TENANT_ID,
    objectId,
    displayName: displayNames[accountId],
  })
  const login = await app.request(
    `${ORIGIN}/auth/login?fragmentCaptured=1`,
    undefined,
    CLIENT,
  )
  expect(login.status).toBe(302)
  const transactionCookie = responseCookie(login, 'free_entra_transaction')
  const callback = await app.request(
    login.headers.get('location')!,
    { headers: { cookie: transactionCookie } },
    CLIENT,
  )
  expect(callback.status).toBe(302)
  return responseCookie(callback, 'free_session')
}

async function appFixture(): Promise<AppFixture> {
  const stores = twoAccountStoreFixture()
  const createStore = vi.fn((accountId: string) => {
    const store = stores.stores.get(accountId)
    if (!store) throw new Error(`Unknown Researcher Account ${accountId}.`)
    return store
  })
  const identityProvider = createInMemoryEntraIdentityProvider()
  const app = await createStudioApp({
    studioOrigin: ORIGIN,
    basePath: '/',
    sessionSecret: SECRET,
    accountStore: accountStore(),
    identityProvider,
    apiDispatcher: createApiDispatcher(ownershipRegistry(stores)),
    researcherProjectStore: createStore,
  })
  return {
    ...stores,
    app,
    createStore,
    cookies: {
      [ids.accountA]: await login(app, identityProvider, objectIds[ids.accountA]),
      [ids.accountB]: await login(app, identityProvider, objectIds[ids.accountB]),
    },
  }
}

async function api(
  fixture: AppFixture,
  accountId: typeof ids.accountA | typeof ids.accountB,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = init.method?.toUpperCase() ?? 'GET'
  const headers = new Headers(init.headers)
  headers.set('cookie', fixture.cookies[accountId])
  if (method !== 'GET' && method !== 'HEAD') headers.set('origin', ORIGIN)
  return fixture.app.request(
    `${ORIGIN}${pathname}`,
    { ...init, headers },
    CLIENT,
  )
}

async function expectPrivateNotFound(
  response: Response,
  forbidden: readonly string[],
): Promise<void> {
  expect(response.status).toBe(404)
  const text = await response.text()
  expect(JSON.parse(text)).toMatchObject({ error: { code: 'not_found' } })
  for (const value of forbidden) expect(text).not.toContain(value)
}

function jsonRequest(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function ingestionRequest(): RequestInit {
  const form = new FormData()
  form.set(
    'file',
    new File([pdfBytes], 'private.pdf', { type: 'application/pdf' }),
  )
  form.set('ingestionKey', ids.ingestion)
  return { method: 'POST', body: form }
}

const forbiddenB = [
  ids.accountB,
  displayNames[ids.accountB],
  ids.projectB,
  projectNames[ids.accountB],
  ids.documentB,
  ids.representationB,
  ids.annotationB,
  ids.schemaB,
  ids.revisionB,
  ids.extractionB,
  ids.batchB,
  ids.batchSuggestionB,
  sharedDescriptor.artifactReference,
  sharedDescriptor.artifactSha256,
] as const

describe('two-account project and source API isolation', () => {
  it('binds list, read, create, rename, and delete to the authenticated account', async () => {
    const fixture = await appFixture()

    const aliceList = await api(fixture, ids.accountA, '/api/project-contexts')
    expect(aliceList.status).toBe(200)
    const aliceText = await aliceList.text()
    expect(aliceText).toContain(ids.projectA)
    expect(aliceText).toContain(projectNames[ids.accountA])
    for (const value of forbiddenB) expect(aliceText).not.toContain(value)

    const bobDetail = await api(
      fixture,
      ids.accountB,
      `/api/project-contexts/${ids.projectB}`,
    )
    expect(bobDetail.status).toBe(200)
    const bobText = await bobDetail.text()
    expect(bobText).toContain(ids.projectB)
    expect(bobText).not.toContain(ids.projectA)
    expect(bobText).not.toContain(ids.accountB)

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectB}`,
      ),
      forbiddenB,
    )

    const forgedOwner = await api(
      fixture,
      ids.accountA,
      '/api/project-contexts',
      jsonRequest('POST', {
        name: 'Forged owner',
        researcherAccountId: ids.accountB,
      }),
    )
    expect(forgedOwner.status).toBe(422)
    expect(
      fixture.stores.get(ids.accountA)!.createProjectContext,
    ).not.toHaveBeenCalled()

    const created = await api(
      fixture,
      ids.accountA,
      '/api/project-contexts',
      jsonRequest('POST', { name: 'Alice second project' }),
    )
    expect(created.status).toBe(201)
    const createdText = await created.text()
    expect(createdText).toContain(ids.createdProjectA)
    expect(createdText).not.toContain(ids.accountA)
    expect(createdText).not.toContain(ids.accountB)

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectB}`,
        jsonRequest('PATCH', { name: 'Stolen' }),
      ),
      forbiddenB,
    )
    expect(
      fixture.relationships.find(
        (relationship) => relationship.accountId === ids.accountB,
      )!.projectName,
    ).toBe(projectNames[ids.accountB])

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectB}`,
        { method: 'DELETE' },
      ),
      forbiddenB,
    )
    expect(
      fixture.relationships.find(
        (relationship) => relationship.accountId === ids.accountB,
      )!.projectPresent,
    ).toBe(true)

    expect(fixture.createStore).toHaveBeenCalledWith(ids.accountA)
    expect(fixture.createStore).toHaveBeenCalledWith(ids.accountB)
  })

  it('rejects cross-owner ingest and deletion before parsing, package writes, or mutation', async () => {
    const fixture = await appFixture()
    const aliceStore = fixture.stores.get(ids.accountA)!

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectB}/source-documents`,
        ingestionRequest(),
      ),
      forbiddenB,
    )
    expect(fixture.parsingFetch).not.toHaveBeenCalled()
    expect(fixture.packageStore.save).not.toHaveBeenCalled()
    expect(aliceStore.ingestSourceDocument).not.toHaveBeenCalled()
    expect(aliceStore.discardCanonicalPackage).not.toHaveBeenCalled()

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectA}/source-documents/${ids.documentB}`,
        { method: 'DELETE' },
      ),
      forbiddenB,
    )
    expect(
      fixture.relationships.find(
        (relationship) => relationship.accountId === ids.accountB,
      )!.documentPresent,
    ).toBe(true)
  })
})

describe('two-account schema, revision, suggestion, editing, and chat isolation', () => {
  it('rejects foreign project, schema, and revision combinations without mutation', async () => {
    const fixture = await appFixture()
    const aliceStore = fixture.stores.get(ids.accountA)!

    const ownSchemas = await api(
      fixture,
      ids.accountA,
      `/api/extraction-schemas?projectContextId=${ids.projectA}`,
    )
    expect(ownSchemas.status).toBe(200)
    const ownSchemasText = await ownSchemas.text()
    expect(ownSchemasText).toContain(ids.schemaA)
    for (const value of forbiddenB) expect(ownSchemasText).not.toContain(value)

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/extraction-schemas?projectContextId=${ids.projectB}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/extraction-schemas/${ids.schemaB}`,
        jsonRequest('PATCH', {
          projectContextId: ids.projectA,
          name: 'Stolen schema',
        }),
      ),
      forbiddenB,
    )
    expect(
      fixture.relationships.find(
        (relationship) => relationship.accountId === ids.accountB,
      )!.schemaName,
    ).toBe('Bob private schema')

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/schema-revisions?projectContextId=${ids.projectA}&extractionSchemaId=${ids.schemaB}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/schema-revisions/${ids.revisionB}?projectContextId=${ids.projectA}&extractionSchemaId=${ids.schemaA}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        '/api/schema-revisions',
        jsonRequest('POST', {
          projectContextId: ids.projectB,
          ...schemaDefinition,
        }),
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        '/api/schema-revisions',
        jsonRequest('POST', {
          projectContextId: ids.projectA,
          extractionSchemaId: ids.schemaB,
          expectedRevisionNumber: 1,
          ...schemaDefinition,
        }),
      ),
      forbiddenB,
    )
    expect(aliceStore.renameExtractionSchema).toHaveBeenCalledWith(
      ids.projectA,
      ids.schemaB,
      'Stolen schema',
    )
    expect(aliceStore.appendSchemaRevision).toHaveBeenCalledWith(
      ids.projectA,
      ids.schemaB,
      1,
      schemaDefinition,
    )
  })

  it('rejects mixed source and schema pins before artifact reads or model execution', async () => {
    const fixture = await appFixture()

    const generateForm = new FormData()
    generateForm.set('project_context_id', ids.projectA)
    generateForm.set(
      'source_representation_revision_id',
      ids.representationB,
    )
    const readsBeforeGenerate = fixture.readArtifact.mock.calls.length
    await expectPrivateNotFound(
      await api(fixture, ids.accountA, '/api/generate_schema', {
        method: 'POST',
        body: generateForm,
      }),
      forbiddenB,
    )
    expect(fixture.readArtifact).toHaveBeenCalledTimes(readsBeforeGenerate)
    expect(fixture.models.generateSchema).not.toHaveBeenCalled()

    const editForm = new FormData()
    editForm.set('project_context_id', ids.projectA)
    editForm.set('source_representation_revision_id', ids.representationA)
    editForm.set('extraction_schema_id', ids.schemaB)
    editForm.set('schema_revision_id', ids.revisionB)
    editForm.set('instruction', 'Do not mutate Bob schema.')
    const readsBeforeEdit = fixture.readArtifact.mock.calls.length
    await expectPrivateNotFound(
      await api(fixture, ids.accountA, '/api/edit_schema', {
        method: 'POST',
        body: editForm,
      }),
      forbiddenB,
    )
    expect(fixture.readArtifact).toHaveBeenCalledTimes(readsBeforeEdit)
    expect(fixture.models.editSchema).not.toHaveBeenCalled()

    const readsBeforeChat = fixture.readArtifact.mock.calls.length
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        '/api/chat',
        jsonRequest('POST', {
          projectContextId: ids.projectA,
          sourceRepresentationRevisionId: ids.representationB,
          messages: [
            {
              id: 'message-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Disclose the foreign document.' }],
            },
          ],
        }),
      ),
      forbiddenB,
    )
    expect(fixture.readArtifact).toHaveBeenCalledTimes(readsBeforeChat)
    expect(fixture.models.chat).not.toHaveBeenCalled()
  })
})


describe('two-account reopen, extraction, result, review, and batch isolation', () => {
  it('rejects foreign documents, annotations, and selected extraction pins on reopen', async () => {
    const fixture = await appFixture()
    const aliceExtractions = fixture.extractionModules[ids.accountA]

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectA}/source-documents/${ids.documentB}/reopen`,
      ),
      forbiddenB,
    )
    expect(aliceExtractions.readDocumentExtractions).not.toHaveBeenCalled()

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/project-contexts/${ids.projectA}/source-documents/${ids.documentA}/reopen?extractionId=${ids.extractionB}`,
      ),
      forbiddenB,
    )
    expect(aliceExtractions.readDocumentExtractions).toHaveBeenCalledWith({
      sourceDocumentId: ids.documentA,
      extractionId: ids.extractionB,
    })
    expect(fixture.extractionEffects.singleExecutions).toEqual([])
    expect(fixture.extractionEffects.reviewMutations).toEqual([])
  })

  it('rejects mixed extraction pins, reads, review, and cancellation without execution or mutation', async () => {
    const fixture = await appFixture()

    for (const [sourceRepresentationRevisionId, schemaRevisionId] of [
      [ids.representationB, ids.revisionA],
      [ids.representationA, ids.revisionB],
    ] as const)
      await expectPrivateNotFound(
        await api(
          fixture,
          ids.accountA,
          '/api/extractions',
          jsonRequest('POST', {
            id: ids.extractionA,
            sourceRepresentationRevisionId,
            schemaRevisionId,
            strategy: 'ARTICLE',
          }),
        ),
        forbiddenB,
      )

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/extractions/${ids.extractionB}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/extractions/${ids.extractionB}/review`,
        jsonRequest('POST', {
          reviewDecisions: [
            {
              resultPath: ['records', 0, 'title'],
              evidenceAnchorId: 'foreign-anchor',
              reviewedOccurrenceIds: ['foreign-occurrence'],
              action: 'APPROVED',
              reviewedValue: null,
            },
          ],
        }),
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/extractions/${ids.extractionB}`,
        { method: 'DELETE' },
      ),
      forbiddenB,
    )

    expect(fixture.extractionEffects.singleExecutions).toEqual([])
    expect(fixture.extractionEffects.reviewMutations).toEqual([])
    expect(fixture.extractionEffects.cancellations).toEqual([])
  })

  it('rejects cross-owner Batch Extraction selection, catalog, item, and result identifiers', async () => {
    const fixture = await appFixture()

    for (const [schemaRevisionId, sourceDocumentIds] of [
      [ids.revisionB, [ids.documentA]],
      [ids.revisionA, [ids.documentB]],
    ] as const)
      await expectPrivateNotFound(
        await api(
          fixture,
          ids.accountA,
          '/api/batch-extractions',
          jsonRequest('POST', {
            projectContextId: ids.projectA,
            schemaRevisionId,
            strategy: 'ARTICLE',
            sourceDocumentIds,
          }),
        ),
        forbiddenB,
      )

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-extractions?projectContextId=${ids.projectB}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-extractions/${ids.batchB}?projectContextId=${ids.projectA}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-extractions/${ids.batchB}/results?projectContextId=${ids.projectA}`,
      ),
      forbiddenB,
    )
    expect(fixture.extractionEffects.batchExecutions).toEqual([])
  })

  it('rejects Batch Schema Suggestion create, read, draft, run, and retry atomically', async () => {
    const fixture = await appFixture()
    const aliceStore = fixture.stores.get(ids.accountA)!

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        '/api/batch-schema-suggestions',
        jsonRequest('POST', {
          projectContextId: ids.projectA,
          sourceDocumentIds: [ids.documentB],
        }),
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-schema-suggestions?projectContextId=${ids.projectB}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-schema-suggestions/${ids.batchSuggestionB}?projectContextId=${ids.projectA}`,
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-schema-suggestions/${ids.batchSuggestionB}/draft?projectContextId=${ids.projectA}`,
        jsonRequest('PATCH', {
          expectedDraftVersion: 1,
          ...schemaDefinition,
        }),
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-schema-suggestions/${ids.batchSuggestionB}/run?projectContextId=${ids.projectA}`,
        jsonRequest('POST', { strategy: 'ARTICLE' }),
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        `/api/batch-schema-suggestions/${ids.batchSuggestionB}/retry?projectContextId=${ids.projectA}`,
        { method: 'POST' },
      ),
      forbiddenB,
    )

    expect(aliceStore.createBatchSchemaSuggestion).toHaveBeenCalledWith(
      ids.projectA,
      [ids.documentB],
    )
    expect(aliceStore.updateBatchSchemaSuggestionDraft).toHaveBeenCalled()
    expect(aliceStore.retryBatchSchemaSuggestion).toHaveBeenCalledWith(
      ids.projectA,
      ids.batchSuggestionB,
    )
    expect(fixture.operationKick).not.toHaveBeenCalled()
    expect(fixture.extractionEffects.suggestedBatchExecutions).toEqual([])
  })
})

describe('two-account physical package isolation', () => {
  it('streams identical content only through each owner relationship and retains the surviving reference', async () => {
    const fixture = await appFixture()
    const artifactPath = (projectId: string, representationId: string, artifact: string) =>
      `/api/project-contexts/${projectId}/source-representations/${representationId}/${artifact}`

    for (const [accountId, projectId, representationId] of [
      [ids.accountA, ids.projectA, ids.representationA],
      [ids.accountB, ids.projectB, ids.representationB],
    ] as const) {
      const response = await api(
        fixture,
        accountId,
        artifactPath(projectId, representationId, 'pdf'),
      )
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(pdfBytes)
      const headers = [...response.headers].flat().join(' ')
      expect(headers).not.toContain(ids.accountA)
      expect(headers).not.toContain(ids.accountB)
      expect(headers).not.toContain(sharedDescriptor.artifactReference)
      expect(headers).not.toContain(sharedDescriptor.artifactSha256)
    }

    const readsBeforeMixed = fixture.readArtifact.mock.calls.length
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        artifactPath(ids.projectA, ids.representationB, 'pdf'),
      ),
      forbiddenB,
    )
    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountB,
        artifactPath(ids.projectB, ids.representationA, 'markdown'),
      ),
      [
        ids.accountA,
        displayNames[ids.accountA],
        ids.projectA,
        ids.documentA,
        ids.representationA,
        sharedDescriptor.artifactReference,
        sharedDescriptor.artifactSha256,
      ],
    )
    expect(fixture.readArtifact).toHaveBeenCalledTimes(readsBeforeMixed)

    const source = await api(
      fixture,
      ids.accountA,
      artifactPath(ids.projectA, ids.representationA, 'source'),
    )
    expect(source.status).toBe(200)
    const sourceText = await source.text()
    expect(sourceText).toContain('parsed_document.v2')
    for (const value of [
      ids.accountA,
      ids.accountB,
      ids.projectA,
      ids.projectB,
      ids.representationA,
      ids.representationB,
      sharedDescriptor.artifactReference,
      sharedDescriptor.artifactSha256,
    ])
      expect(sourceText).not.toContain(value)

    const deleted = await api(
      fixture,
      ids.accountA,
      `/api/project-contexts/${ids.projectA}/source-documents/${ids.documentA}`,
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(204)

    await expectPrivateNotFound(
      await api(
        fixture,
        ids.accountA,
        artifactPath(ids.projectA, ids.representationA, 'pdf'),
      ),
      [ids.accountB, sharedDescriptor.artifactReference],
    )
    const bobStillReads = await api(
      fixture,
      ids.accountB,
      artifactPath(ids.projectB, ids.representationB, 'pdf'),
    )
    expect(bobStillReads.status).toBe(200)
    expect(new Uint8Array(await bobStillReads.arrayBuffer())).toEqual(pdfBytes)
  })
})
