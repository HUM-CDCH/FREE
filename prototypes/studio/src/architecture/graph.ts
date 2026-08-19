import type { ArchitectureData } from './components/ArchitectureMap'
import {
  deriveArchetype,
  deriveHeight,
  deriveSize,
  packLayout,
  type Measure,
} from './core/layout'
import type { ArchEdge, ArchFlow, ArchNode, Group } from './core/types'
import { MEASURED, UNCLAIMED } from './measured.generated'

export const GROUPS: readonly Group[] = [
  { id: 'workspace', label: 'Research workspace' },
  { id: 'control', label: 'Studio control plane' },
  { id: 'parsing', label: 'The parsing works' },
  { id: 'data', label: 'Durable research data' },
  { id: 'engineering', label: 'Engineering compass' },
  { id: 'outside', label: 'Outside world' },
]

type NodeDraft = Omit<
  ArchNode,
  'archetype' | 'params' | 'footprint' | 'height' | 'count' | 'loc'
>

const DRAFTS: readonly NodeDraft[] = [
  {
    id: 'studio-shell',
    code: 'SH',
    name: 'Studio shell',
    role: 'the browser entry',
    group: 'workspace',
    whatItDoes:
      'Starts FREE in the browser and chooses the page that owns the current URL. It keeps the persistent Project Context rail around the researcher’s active work.',
    howItsBuilt:
      'Navigation is a small [[state machine]] over browser history rather than a router dependency. A route is parsed first, then document routes wait until the selected Source Document is proven to belong to its Project Context.',
    files: [
      'prototypes/studio/src/main.tsx',
      'prototypes/studio/src/ProjectNavigation.tsx',
      'prototypes/studio/src/projectNavigation.ts',
      'prototypes/studio/src/AppFrame.tsx',
    ],
    stack: ['React', 'XState', 'History API'],
  },
  {
    id: 'project-workspace',
    code: 'PC',
    name: 'Project Contexts',
    role: 'the research organizer',
    group: 'workspace',
    whatItDoes:
      'Lists Project Contexts and their Source Documents, manages the active page, and keeps multi-document ingestion alive while a researcher navigates elsewhere.',
    howItsBuilt:
      'The provider owns the [[ingestion queue]] above individual pages. Each selected PDF becomes a stable queued item and is submitted sequentially, so navigation cannot silently abandon the remaining work.',
    files: [
      'prototypes/studio/src/projectContexts/ProjectContextsProvider.tsx',
      'prototypes/studio/src/projectContexts/ProjectContextRail.tsx',
      'prototypes/studio/src/projectContexts/ProjectContextPage.tsx',
      'prototypes/studio/src/projectContexts/transport.ts',
      'prototypes/studio/src/sourceIngestionMachine.ts',
    ],
    stack: ['React', 'XState', 'Zod'],
  },
  {
    id: 'document-workspace',
    code: 'DW',
    name: 'Document workspace',
    role: 'the evidence desk',
    group: 'workspace',
    whatItDoes:
      'Lets a humanities researcher read a Source Document, annotate it, shape an Extraction Schema, run Extraction, and inspect source-linked Evidence and results.',
    howItsBuilt:
      'One workspace coordinates PDF.js, schema editing, model requests, and reviewed results while keeping [[Evidence Anchors]] tied to canonical parsed content instead of screen geometry.',
    files: [
      'prototypes/studio/src/App.tsx',
      'prototypes/studio/src/SchemaPanel.tsx',
      'prototypes/studio/src/useExtraction.ts',
      'prototypes/studio/src/ResultsTab.tsx',
      'prototypes/studio/src/EvidenceTab.tsx',
      'prototypes/studio/src/ExtractionResultExportControl.tsx',
    ],
    stack: ['React', 'PDF.js', 'XState', 'Zod'],
  },
  {
    id: 'model-settings',
    code: 'MC',
    name: 'Model connections',
    role: 'the capability switchboard',
    group: 'workspace',
    whatItDoes:
      'Shows the machine-wide Model Connections and assigns models to the Extraction and Interaction Capability Routes. It also exposes an opt-in inspector for model traffic.',
    howItsBuilt:
      'The browser edits a sanitized draft and probes providers separately from Apply. Credential values never return to the page, and [[discovery is advisory]] rather than a gate on saving.',
    files: [
      'prototypes/studio/src/providerConfig/ProviderConfigPage.tsx',
      'prototypes/studio/src/providerConfig/providerConfig.data.ts',
      'prototypes/studio/src/providerConfig/useProviderConfigDraft.ts',
      'prototypes/studio/src/providerConfig/useProbeLifecycle.ts',
      'prototypes/studio/src/llmInspector/mount.tsx',
    ],
    stack: ['React', 'Zod', 'OS keyring'],
  },
  {
    id: 'ui-kit',
    code: 'UI',
    name: 'Studio language',
    role: 'the visual grammar',
    group: 'workspace',
    whatItDoes:
      'Defines FREE’s warm paper-like palette, typography, reusable controls, result rendering, and the PDF viewer’s finishing styles.',
    howItsBuilt:
      'Tailwind v4 tokens live in one global stylesheet; small React primitives stay local and explicit. The palette is [[light-only]] today, so the architecture map follows the same contract.',
    files: [
      'prototypes/studio/src/index.css',
      'prototypes/studio/src/pdf-viewer.css',
      'prototypes/studio/src/ui/Button.tsx',
      'prototypes/studio/src/ui/Panel.tsx',
      'prototypes/studio/src/ui/ResultValue.tsx',
    ],
    stack: ['Tailwind CSS', 'Albert Sans', 'Source Serif 4'],
  },
  {
    id: 'api-foundation',
    code: 'AF',
    name: 'HTTP foundation',
    role: 'the same-origin adapter',
    group: 'control',
    whatItDoes:
      'Turns Studio’s TypeScript Request/Response handlers into same-origin `/api` endpoints and gives every handler the same JSON, validation, cache, and error behavior.',
    howItsBuilt:
      'Vite discovers public handler modules by path during local development. Private `_` modules stay unreachable, and a mistyped API path returns structured JSON instead of falling through to the SPA.',
    files: [
      'prototypes/studio/vite.config.ts',
      'prototypes/studio/api/_http.ts',
      'prototypes/studio/api/healthz.ts',
      'prototypes/studio/api/_environment.test.ts',
    ],
    stack: ['Vite', 'Fetch API', 'Zod'],
  },
  {
    id: 'project-api',
    code: 'PA',
    name: 'Research state API',
    role: 'the durable state gate',
    group: 'control',
    whatItDoes:
      'Creates, renames, reads, and deletes Project Contexts, then appends immutable Schema Revisions and exposes saved Extraction Schemas.',
    howItsBuilt:
      'Handlers contain HTTP grammar but no SQL. Revision writes use an [[expected revision number]] so a stale browser tab receives a conflict instead of overwriting later research state.',
    files: [
      'prototypes/studio/api/project_contexts.ts',
      'prototypes/studio/api/schema_revisions.ts',
      'prototypes/studio/api/extraction_schemas.ts',
      'prototypes/studio/api/project_contexts.test.ts',
    ],
    stack: ['Fetch API', 'Zod', 'ProjectStore'],
  },
  {
    id: 'ingestion-api',
    code: 'IG',
    name: 'Source gateway',
    role: 'the ingestion broker',
    group: 'control',
    whatItDoes:
      'Accepts Source Documents, drives Parsing Service tasks to completion, retains canonical packages, commits revision 1, and later reopens the pinned representation.',
    howItsBuilt:
      'The handler acknowledges a Source Document only after its validated [[canonical package]] is durable. Reopen never reparses: it reads the representation pinned in PostgreSQL and serves entries from that package.',
    files: [
      'prototypes/studio/api/source_documents.ts',
      'prototypes/studio/api/document_reopen.ts',
      'prototypes/studio/api/source_representations.ts',
      'prototypes/studio/api/_document.ts',
      'prototypes/studio/api/_pdf.ts',
    ],
    stack: ['Fetch API', 'fflate', 'ProjectStore'],
  },
  {
    id: 'model-operations',
    code: 'MO',
    name: 'Model operations',
    role: 'the model boundary',
    group: 'control',
    whatItDoes:
      'Runs chat, Schema Suggestion, schema editing, provider probes, and model configuration through the configured Capability Route.',
    howItsBuilt:
      'Provider differences stop at explicit adapters. NuExtract on Ollama uses a hand-built [[raw prompt]], while general providers use AI SDK protocols; every result is normalized before product code sees it.',
    files: [
      'prototypes/studio/api/_provider.ts',
      'prototypes/studio/api/_model.ts',
      'prototypes/studio/api/generate_schema.ts',
      'prototypes/studio/api/edit_schema.ts',
      'prototypes/studio/api/model_config.ts',
      'prototypes/studio/api/model_probe.ts',
    ],
    stack: ['AI SDK', 'Ollama', 'Anthropic', 'Google', 'OpenAI'],
  },
  {
    id: 'extraction-operations',
    code: 'EX',
    name: 'Extraction operations',
    role: 'the durable work runner',
    group: 'control',
    whatItDoes:
      'Runs single and Batch Extractions, durable Batch Schema Suggestions, evidence grounding, retries, and explicit review persistence.',
    howItsBuilt:
      'Batch membership and progress are stored before work begins. A process-local kicker resumes [[server-owned operations]], while deterministic identities and terminal writes keep correctness in PostgreSQL.',
    files: [
      'prototypes/studio/api/extractions.ts',
      'prototypes/studio/api/batch_extractions.ts',
      'prototypes/studio/api/batch_schema_suggestions.ts',
      'prototypes/studio/api/_project_operations.ts',
      'prototypes/studio/api/_batch_schema_suggestions.ts',
    ],
    stack: ['AI SDK', 'ProjectStore', 'Zod'],
  },
  {
    id: 'shared-contracts',
    code: 'CT',
    name: 'Shared contracts',
    role: 'the shape ledger',
    group: 'control',
    whatItDoes:
      'Defines the request, response, Evidence, schema, batch, and model-configuration shapes understood by both browser and handlers.',
    howItsBuilt:
      'Zod schemas are the runtime boundary and TypeScript types are inferred from them. Strict parsing makes malformed or stale payloads fail where they cross the boundary.',
    files: [
      'prototypes/studio/shared/projectContext.contract.ts',
      'prototypes/studio/shared/sourceDocumentIngestion.contract.ts',
      'prototypes/studio/shared/schemaRevision.contract.ts',
      'prototypes/studio/shared/extraction.contract.ts',
      'prototypes/studio/shared/batchExtraction.contract.ts',
      'prototypes/studio/shared/modelConfig.contract.ts',
    ],
    stack: ['Zod', 'TypeScript'],
  },
  {
    id: 'parsing-http',
    code: 'PH',
    name: 'Parsing API',
    role: 'the task control plane',
    group: 'parsing',
    whatItDoes:
      'Accepts PDF-only parsing tasks, reports their lifecycle, and serves canonical document, Markdown, source, and package artifacts.',
    howItsBuilt:
      'FastAPI routes keep task IDs and admission rules explicit. Task directories are a [[processor cache]], not the durable representation that Studio reopens later.',
    files: [
      'prototypes/parsing_service/app/main.py',
      'prototypes/parsing_service/app/api/routes_tasks.py',
      'prototypes/parsing_service/app/api/routes_documents.py',
      'prototypes/parsing_service/app/api/routes_artifacts.py',
      'prototypes/parsing_service/app/api/request_admission.py',
    ],
    stack: ['FastAPI', 'Pydantic', 'Uvicorn'],
  },
  {
    id: 'parsing-intake',
    code: 'IN',
    name: 'PDF intake',
    role: 'the source guard',
    group: 'parsing',
    whatItDoes:
      'Validates incoming PDFs, records safe source metadata, and defines the canonical parsed-document and parser-output models used by the rest of the service.',
    howItsBuilt:
      'Source bytes are hashed and stored under a content identity while the original name is treated as display metadata. Pydantic models freeze the `parsed_document.v2` contract.',
    files: [
      'prototypes/parsing_service/app/ingestion/upload.py',
      'prototypes/parsing_service/app/ingestion/validation.py',
      'prototypes/parsing_service/app/models/parsed_document_v2.py',
      'prototypes/parsing_service/app/models/parser_output.py',
    ],
    stack: ['Pydantic', 'SHA-256'],
  },
  {
    id: 'parsing-workers',
    code: 'WK',
    name: 'Parse workers',
    role: 'the task executor',
    group: 'parsing',
    whatItDoes:
      'Moves an admitted task through running, cancellation, failure, and completion while invoking the blocking parsing pipeline away from the HTTP request.',
    howItsBuilt:
      'Workers publish task state atomically and keep GPU selection isolated. The task lifecycle is explicit so interruption cannot masquerade as a successful generation.',
    files: [
      'prototypes/parsing_service/app/workers/parse_worker.py',
      'prototypes/parsing_service/app/workers/_task_state.py',
      'prototypes/parsing_service/app/workers/gpu.py',
      'prototypes/parsing_service/app/timing.py',
    ],
    stack: ['Python threads', 'CUDA policy'],
  },
  {
    id: 'parsing-pipeline',
    code: 'PP',
    name: 'Canonical pipeline',
    role: 'the document foundry',
    group: 'parsing',
    whatItDoes:
      'Turns one Source Document into a normalized content stream, logical tables, Evidence Anchors, canonical Markdown, and `parsed_document.v2`.',
    howItsBuilt:
      'Docling supplies structural inventory, with targeted OCR and table fallbacks when needed. Publication separates [[semantic content]] from renderer-specific geometry so downstream Evidence remains portable.',
    files: [
      'prototypes/parsing_service/app/parsing/orchestrator.py',
      'prototypes/parsing_service/app/parsing/docling_runner.py',
      'prototypes/parsing_service/app/parsing/ocr_fallback.py',
      'prototypes/parsing_service/app/parsing/table_extraction.py',
      'prototypes/parsing_service/app/parsing/semantic_stream.py',
      'prototypes/parsing_service/app/parsing/v2_publication.py',
    ],
    stack: ['Docling', 'PaddleOCR', 'Camelot', 'PyMuPDF'],
  },
  {
    id: 'parsing-storage',
    code: 'PS',
    name: 'Generation cache',
    role: 'the immutable publisher',
    group: 'parsing',
    whatItDoes:
      'Stores task state, source blobs, immutable generations, manifests, and the canonical ZIP that the Parsing API delivers to Studio.',
    howItsBuilt:
      'Atomic JSON writes and generation manifests make partial publication invisible. The package has a fixed four-entry layout with hashes and normalized paths.',
    files: [
      'prototypes/parsing_service/app/storage/canonical_package.py',
      'prototypes/parsing_service/app/storage/manifests.py',
      'prototypes/parsing_service/app/storage/blobs.py',
      'prototypes/parsing_service/app/storage/atomic_json.py',
      'prototypes/parsing_service/app/storage/paths.py',
    ],
    stack: ['ZIP', 'JSON', 'SHA-256'],
  },
  {
    id: 'parsing-verification',
    code: 'PV',
    name: 'Parsing proofs',
    role: 'the pipeline witness',
    group: 'parsing',
    whatItDoes:
      'Exercises canonical generation, Docling integration, Markdown rendering, OCR, table recovery, storage safety, and HTTP artifact behavior.',
    howItsBuilt:
      'Focused unit fixtures cover deterministic rules; selected integration tests cross real library boundaries. Storage tests share helpers that create isolated task directories.',
    files: [
      'prototypes/parsing_service/tests/test_docling_integration.py',
      'prototypes/parsing_service/tests/test_canonical_generation_binding.py',
      'prototypes/parsing_service/tests/test_table_extraction.py',
      'prototypes/parsing_service/tests/test_storage_security.py',
      'prototypes/parsing_service/tests/storage_test_support.py',
    ],
    stack: ['unittest', 'Docling'],
  },
  {
    id: 'simple-parser',
    code: 'SP',
    name: 'Simple parser',
    role: 'the narrow prototype',
    group: 'parsing',
    whatItDoes:
      'Provides a smaller Docling-only FastAPI service that proves the same task and package contract with fewer moving parts.',
    howItsBuilt:
      'One reusable converter is initialized during application lifespan and one parser seam keeps tests independent of model downloads. It is intentionally a separate prototype, not a compatibility path.',
    files: [
      'prototypes/parsing_service_simple/app/main.py',
      'prototypes/parsing_service_simple/app/tasks.py',
      'prototypes/parsing_service_simple/app/docling_parser.py',
      'prototypes/parsing_service_simple/app/storage.py',
      'prototypes/parsing_service_simple/tests/test_http_contract.py',
    ],
    stack: ['FastAPI', 'Docling', 'Pydantic'],
  },
  {
    id: 'project-store',
    code: 'DB',
    name: 'ProjectStore',
    role: 'the persistence membrane',
    group: 'data',
    whatItDoes:
      'Owns every durable read and write for Project Contexts, Source Documents, representations, Schema Revisions, operations, Extractions, Evidence, and Review Decisions.',
    howItsBuilt:
      'Handlers call a domain-shaped interface instead of issuing SQL. Multi-record transitions stay inside transactions, and content-addressed package references are stored separately from package bytes.',
    files: [
      'packages/db/src/project-store.ts',
      'packages/db/src/artifact-store.ts',
      'packages/db/src/seed.ts',
      'packages/db/src/project-store.postgres.check.ts',
      'packages/db/src/extraction-lifecycle.integration.test.ts',
    ],
    stack: ['Prisma Next', 'PostgreSQL', 'fflate'],
  },
  {
    id: 'database-contract',
    code: 'SC',
    name: 'Database contract',
    role: 'the relational constitution',
    group: 'data',
    whatItDoes:
      'Defines the PostgreSQL schema and its ordered application migrations, then emits the generated TypeScript contract consumed by ProjectStore.',
    howItsBuilt:
      'Migration snapshots retain both start and end contracts so schema changes are reviewable as data as well as code. Cascades encode Project Context ownership at the database boundary.',
    files: [
      'packages/db/src/prisma/contract.prisma',
      'packages/db/src/prisma/db.ts',
      'packages/db/migrations/app/20260810T1851_baseline/migration.ts',
      'packages/db/migrations/app/20260814T1741_batch_extractions/migration.ts',
      'packages/db/prisma-next.config.ts',
    ],
    stack: ['PostgreSQL', 'Prisma Next'],
  },
  {
    id: 'export-toolkit',
    code: 'XP',
    name: 'Result exports',
    role: 'the download formatter',
    group: 'data',
    whatItDoes:
      'Turns reviewed Extraction Results into safe browser downloads in CSV and XLSX while preserving tables, filenames, and scalar value rules.',
    howItsBuilt:
      'Formatting is a dependency-light workspace package shared by Studio and tested against browser-like download behavior. Spreadsheet safety is handled before cells leave the product.',
    files: [
      'packages/extraction-result-export/src/index.ts',
      'packages/extraction-result-export/src/csv.ts',
      'packages/extraction-result-export/src/xlsx.ts',
      'packages/extraction-result-export/src/download.ts',
      'packages/extraction-result-export/src/safety.ts',
    ],
    stack: ['TypeScript', 'SheetJS'],
  },
  {
    id: 'engineering-map',
    code: 'AM',
    name: 'Architecture & delivery',
    role: 'the engineering compass',
    group: 'engineering',
    whatItDoes:
      'Orchestrates workspace development and verification, documents implemented and target architecture, and renders this measured interactive map.',
    howItsBuilt:
      'The authored map claims meaning while the sync script owns counts and drift. LikeC4 remains the broader current-versus-target model; this page is the code-level [[walking map]].',
    files: [
      'package.json',
      'pnpm-workspace.yaml',
      'docs/architecture/current.c4',
      'docs/architecture/distribution.c4',
      'scripts/architecture-sync.mjs',
      'prototypes/studio/src/architecture/graph.ts',
    ],
    stack: ['pnpm', 'Vite', 'Vitest', 'Playwright', 'LikeC4'],
  },
  {
    id: 'postgres',
    code: 'PG',
    name: 'PostgreSQL',
    role: 'the durable ledger',
    group: 'outside',
    whatItDoes:
      'Persists the relational research record: Project Context ownership, immutable revisions, durable operations, Extraction Results, Evidence, and Review Decisions.',
    howItsBuilt:
      'PostgreSQL 17 is reached only through ProjectStore. Integration tests require an explicitly disposable `free_test_*` database rather than silently skipping durability checks.',
    files: [
      'packages/db/docker-compose.yml',
      'packages/db/src/database-url.ts',
      'packages/db/src/project-store.postgres.check.ts',
    ],
    stack: ['PostgreSQL 17'],
  },
  {
    id: 'canonical-packages',
    code: 'PK',
    name: 'Canonical packages',
    role: 'the portable artifact store',
    group: 'outside',
    whatItDoes:
      'Keeps content-addressed canonical ingestion packages in the operating system’s FREE Studio data directory so Source Representations can reopen without the parser cache.',
    howItsBuilt:
      'Each ZIP is validated before publication and addressed by its own SHA-256. Deletion quarantines a candidate and rechecks references before unlinking, protecting concurrent publication.',
    files: [
      'packages/db/src/artifact-store.ts',
      'prototypes/studio/api/source_documents.ts',
      'prototypes/studio/api/source_representations.ts',
    ],
    stack: ['OS data directory', 'ZIP', 'SHA-256'],
  },
  {
    id: 'model-providers',
    code: 'AI',
    name: 'Model providers',
    role: 'the configured inference engine',
    group: 'outside',
    whatItDoes:
      'Executes the model work selected by FREE’s Capability Routes, whether through a local service, a remote API, or an authenticated local CLI harness.',
    howItsBuilt:
      'The provider registry exposes one normalized seam while retaining protocol-specific behavior. Credentials remain in the OS keyring and responses return with sanitized Model Attribution.',
    files: [
      'prototypes/studio/api/_provider.ts',
      'prototypes/studio/api/_model.ts',
      'prototypes/studio/shared/modelConfig.contract.ts',
    ],
    stack: ['Ollama', 'Anthropic', 'Google', 'OpenAI', 'Claude Code', 'Codex CLI'],
  },
]

function measurement(id: string): Measure {
  return MEASURED[id] ?? { count: 0, loc: 0 }
}

const geometry = new Map(
  DRAFTS.map((draft) => {
    const measure = measurement(draft.id)
    const shape = deriveArchetype(measure)
    return [draft.id, { measure, ...shape }] as const
  }),
)

const footprints = packLayout(
  DRAFTS.map((draft) => {
    const derived = geometry.get(draft.id)!
    return {
      item: draft.id,
      group: draft.group,
      size: deriveSize(derived.archetype, derived.params, derived.measure),
    }
  }),
  GROUPS.map((group) => group.id),
)

export const NODES: readonly ArchNode[] = DRAFTS.map((draft) => {
  const derived = geometry.get(draft.id)!
  return {
    ...draft,
    archetype: derived.archetype,
    params: derived.params,
    footprint: footprints.get(draft.id)!,
    height: deriveHeight(derived.measure),
    count: derived.measure.count,
    loc: derived.measure.loc,
  }
})

export const EDGES: readonly ArchEdge[] = [
  { id: 'shell-projects', from: 'studio-shell', to: 'project-workspace', kind: 'call', label: 'active route', flowIds: [] },
  { id: 'shell-document', from: 'studio-shell', to: 'document-workspace', kind: 'call', label: 'contained Source Document', flowIds: [] },
  { id: 'projects-upload', from: 'project-workspace', to: 'ingestion-api', kind: 'call', label: 'Source Document + ingestion key', flowIds: ['add-source'] },
  { id: 'ingestion-start-parse', from: 'ingestion-api', to: 'parsing-http', kind: 'call', label: 'task upload, polling, download', flowIds: ['add-source'] },
  { id: 'http-admit-source', from: 'parsing-http', to: 'parsing-intake', kind: 'call', label: 'validated PDF bytes', flowIds: ['add-source'] },
  { id: 'intake-queue-task', from: 'parsing-intake', to: 'parsing-workers', kind: 'call', label: 'task identity + source path', flowIds: ['add-source'] },
  { id: 'worker-run-pipeline', from: 'parsing-workers', to: 'parsing-pipeline', kind: 'call', label: 'parse context', flowIds: ['add-source'] },
  { id: 'pipeline-publish-generation', from: 'parsing-pipeline', to: 'parsing-storage', kind: 'data', label: 'canonical generation', flowIds: ['add-source'] },
  { id: 'storage-return-generation', from: 'parsing-storage', to: 'parsing-http', kind: 'data', label: 'task state + package', flowIds: ['add-source'] },
  { id: 'http-return-package', from: 'parsing-http', to: 'ingestion-api', kind: 'data', label: 'canonical package ZIP', flowIds: ['add-source'] },
  { id: 'ingestion-retain-package', from: 'ingestion-api', to: 'canonical-packages', kind: 'data', label: 'validated package bytes', flowIds: ['add-source'] },
  { id: 'package-return-address', from: 'canonical-packages', to: 'ingestion-api', kind: 'data', label: 'content address', flowIds: ['add-source'] },
  { id: 'ingestion-commit-source', from: 'ingestion-api', to: 'project-store', kind: 'call', label: 'Source Document + revision 1', flowIds: ['add-source'] },
  { id: 'store-write-postgres', from: 'project-store', to: 'postgres', kind: 'data', label: 'transaction', flowIds: ['add-source', 'save-schema', 'run-extraction'] },
  { id: 'postgres-confirm-write', from: 'postgres', to: 'project-store', kind: 'data', label: 'committed state', flowIds: ['add-source', 'save-schema', 'run-extraction'] },
  { id: 'store-return-source', from: 'project-store', to: 'ingestion-api', kind: 'data', label: 'saved Source Document', flowIds: ['add-source'] },
  { id: 'ingestion-ack-projects', from: 'ingestion-api', to: 'project-workspace', kind: 'data', label: 'durable Source Document card', flowIds: ['add-source'] },
  { id: 'projects-reopen', from: 'project-workspace', to: 'ingestion-api', kind: 'call', label: 'reopen identity', flowIds: ['reopen-source'] },
  { id: 'ingestion-read-snapshot', from: 'ingestion-api', to: 'project-store', kind: 'call', label: 'pinned representation query', flowIds: ['reopen-source'] },
  { id: 'store-query-postgres', from: 'project-store', to: 'postgres', kind: 'data', label: 'snapshot query', flowIds: ['reopen-source'] },
  { id: 'postgres-return-snapshot', from: 'postgres', to: 'project-store', kind: 'data', label: 'research snapshot', flowIds: ['reopen-source'] },
  { id: 'store-return-snapshot', from: 'project-store', to: 'ingestion-api', kind: 'data', label: 'artifact references', flowIds: ['reopen-source'] },
  { id: 'ingestion-read-package', from: 'ingestion-api', to: 'canonical-packages', kind: 'call', label: 'pinned package entries', flowIds: ['reopen-source'] },
  { id: 'package-return-entries', from: 'canonical-packages', to: 'ingestion-api', kind: 'data', label: 'PDF, Markdown, parsed document', flowIds: ['reopen-source'] },
  { id: 'ingestion-show-document', from: 'ingestion-api', to: 'document-workspace', kind: 'data', label: 'reopen snapshot + artifacts', flowIds: ['reopen-source'] },
  { id: 'document-request-model', from: 'document-workspace', to: 'model-operations', kind: 'call', label: 'Source Context + guidance', flowIds: ['suggest-schema'] },
  { id: 'model-call-provider', from: 'model-operations', to: 'model-providers', kind: 'call', label: 'provider request', flowIds: ['suggest-schema', 'run-extraction', 'run-batch'] },
  { id: 'provider-return-model', from: 'model-providers', to: 'model-operations', kind: 'data', label: 'model result', flowIds: ['suggest-schema', 'run-extraction', 'run-batch'] },
  { id: 'model-return-document', from: 'model-operations', to: 'document-workspace', kind: 'data', label: 'editable Schema Suggestion', flowIds: ['suggest-schema'] },
  { id: 'document-save-schema', from: 'document-workspace', to: 'project-api', kind: 'call', label: 'expected revision + schema', flowIds: ['save-schema'] },
  { id: 'project-api-store', from: 'project-api', to: 'project-store', kind: 'call', label: 'append Schema Revision', flowIds: ['save-schema'] },
  { id: 'store-return-project-api', from: 'project-store', to: 'project-api', kind: 'data', label: 'Current Schema Revision', flowIds: ['save-schema'] },
  { id: 'project-api-return-document', from: 'project-api', to: 'document-workspace', kind: 'data', label: 'saved schema identity', flowIds: ['save-schema'] },
  { id: 'document-run-extraction', from: 'document-workspace', to: 'extraction-operations', kind: 'call', label: 'pinned schema + Source Context', flowIds: ['run-extraction'] },
  { id: 'extraction-dispatch-model', from: 'extraction-operations', to: 'model-operations', kind: 'call', label: 'Extraction or grounding request', flowIds: ['run-extraction', 'run-batch'] },
  { id: 'model-return-extraction', from: 'model-operations', to: 'extraction-operations', kind: 'data', label: 'values + grounded Evidence', flowIds: ['run-extraction', 'run-batch'] },
  { id: 'extraction-ground-persist', from: 'extraction-operations', to: 'project-store', kind: 'call', label: 'result + Review Decisions', flowIds: ['run-extraction'] },
  { id: 'store-return-extraction', from: 'project-store', to: 'extraction-operations', kind: 'data', label: 'durable Extraction identity', flowIds: ['run-extraction', 'run-batch'] },
  { id: 'extraction-return-document', from: 'extraction-operations', to: 'document-workspace', kind: 'data', label: 'reviewable Extraction Result', flowIds: ['run-extraction'] },
  { id: 'projects-open-batch', from: 'project-workspace', to: 'extraction-operations', kind: 'call', label: 'member selection + Current Schema', flowIds: ['run-batch'] },
  { id: 'batch-open-store', from: 'extraction-operations', to: 'project-store', kind: 'call', label: 'durable batch membership', flowIds: ['run-batch'] },
  { id: 'store-open-batch', from: 'project-store', to: 'postgres', kind: 'data', label: 'persisted batch membership', flowIds: ['run-batch'] },
  { id: 'postgres-confirm-batch', from: 'postgres', to: 'project-store', kind: 'data', label: 'opened batch', flowIds: ['run-batch'] },
  { id: 'store-return-batch', from: 'project-store', to: 'extraction-operations', kind: 'data', label: 'next durable member', flowIds: ['run-batch'] },
  { id: 'batch-persist-member', from: 'extraction-operations', to: 'project-store', kind: 'call', label: 'terminal member outcome', flowIds: ['run-batch'] },
  { id: 'store-write-member', from: 'project-store', to: 'postgres', kind: 'data', label: 'terminal Extraction + progress', flowIds: ['run-batch'] },
  { id: 'postgres-confirm-member', from: 'postgres', to: 'project-store', kind: 'data', label: 'durable member outcome', flowIds: ['run-batch'] },
  { id: 'batch-return-projects', from: 'extraction-operations', to: 'project-workspace', kind: 'data', label: 'persisted progress snapshot', flowIds: ['run-batch'] },
  { id: 'settings-request-model', from: 'model-settings', to: 'model-operations', kind: 'call', label: 'probe or sanitized configuration', flowIds: [] },
  { id: 'model-return-settings', from: 'model-operations', to: 'model-settings', kind: 'data', label: 'probe + committed state', flowIds: [] },
  { id: 'document-export', from: 'document-workspace', to: 'export-toolkit', kind: 'call', label: 'reviewed values', flowIds: [] },
  { id: 'workspace-contracts', from: 'project-workspace', to: 'shared-contracts', kind: 'support', label: 'parsed browser payloads', flowIds: [] },
  { id: 'api-contracts', from: 'api-foundation', to: 'shared-contracts', kind: 'support', label: 'validated HTTP shapes', flowIds: [] },
  { id: 'project-api-http', from: 'project-api', to: 'api-foundation', kind: 'support', label: 'JSON and error policy', flowIds: [] },
  { id: 'ingestion-api-http', from: 'ingestion-api', to: 'api-foundation', kind: 'support', label: 'multipart and no-store policy', flowIds: [] },
  { id: 'model-api-http', from: 'model-operations', to: 'api-foundation', kind: 'support', label: 'stream and error policy', flowIds: [] },
  { id: 'extraction-api-http', from: 'extraction-operations', to: 'api-foundation', kind: 'support', label: 'operation responses', flowIds: [] },
  { id: 'verify-pipeline', from: 'parsing-verification', to: 'parsing-pipeline', kind: 'support', label: 'fixtures and invariants', flowIds: [] },
  { id: 'store-contract', from: 'project-store', to: 'database-contract', kind: 'support', label: 'generated Prisma contract', flowIds: [] },
]

export const FLOWS: readonly ArchFlow[] = [
  {
    id: 'add-source',
    name: 'Add Source Document',
    payload: 'canonical package',
    summary: 'Parse one selected Source Document, retain its portable package, and publish revision 1 only after durability is secured.',
    route: [
      'projects-upload', 'ingestion-start-parse', 'http-admit-source',
      'intake-queue-task', 'worker-run-pipeline', 'pipeline-publish-generation',
      'storage-return-generation', 'http-return-package', 'ingestion-retain-package',
      'package-return-address', 'ingestion-commit-source', 'store-write-postgres',
      'postgres-confirm-write', 'store-return-source', 'ingestion-ack-projects',
    ],
  },
  {
    id: 'reopen-source',
    name: 'Reopen Source Document',
    payload: 'pinned snapshot',
    summary: 'Resolve the durable Source Representation and read its artifacts without depending on the Parsing Service cache.',
    route: [
      'projects-reopen', 'ingestion-read-snapshot', 'store-query-postgres',
      'postgres-return-snapshot', 'store-return-snapshot', 'ingestion-read-package',
      'package-return-entries', 'ingestion-show-document',
    ],
  },
  {
    id: 'suggest-schema',
    name: 'Suggest Schema',
    payload: 'schema proposal',
    summary: 'Send Source Context through the Extraction Route and return an editable, source-aware Schema Suggestion.',
    route: [
      'document-request-model', 'model-call-provider', 'provider-return-model',
      'model-return-document',
    ],
  },
  {
    id: 'save-schema',
    name: 'Save Schema Revision',
    payload: 'immutable schema',
    summary: 'Append an Extraction Schema against the expected Current Schema Revision and return its durable identity.',
    route: [
      'document-save-schema', 'project-api-store', 'store-write-postgres',
      'postgres-confirm-write', 'store-return-project-api', 'project-api-return-document',
    ],
  },
  {
    id: 'run-extraction',
    name: 'Run and Review',
    payload: 'grounded result',
    summary: 'Extract values, ground them against canonical Evidence Anchors, and persist the reviewed result with its decisions.',
    route: [
      'document-run-extraction', 'extraction-dispatch-model', 'model-call-provider',
      'provider-return-model', 'model-return-extraction', 'extraction-ground-persist',
      'store-write-postgres', 'postgres-confirm-write', 'store-return-extraction',
      'extraction-return-document',
    ],
  },
  {
    id: 'run-batch',
    name: 'Run Batch Extraction',
    payload: 'member outcome',
    summary: 'Persist the selected membership first, run each Source Document through the model boundary, and report progress from durable state.',
    route: [
      'projects-open-batch', 'batch-open-store', 'store-open-batch',
      'postgres-confirm-batch', 'store-return-batch', 'extraction-dispatch-model',
      'model-call-provider', 'provider-return-model', 'model-return-extraction',
      'batch-persist-member', 'store-write-member', 'postgres-confirm-member',
      'store-return-extraction', 'batch-return-projects',
    ],
  },
]

export const INTRO = {
  title: 'FREE, as implemented',
  lede:
    'A measured map of the localhost research workflow: Source Documents enter through Studio, become canonical packages in the Parsing Service, and return as durable, evidence-grounded research state.',
  whatItDoes:
    'Walk a product flow to see which modules actually carry it. Select a building to read its purpose, the architectural decision inside it, and representative paths to inspect.',
  howItsBuilt:
    'Subsystem meaning, real call paths, and flow narration are authored from the code. File counts, line totals, building shapes, heights, footprints, and unmapped drift are derived on every sync.',
}

export const ARCHITECTURE = {
  groups: GROUPS,
  nodes: NODES,
  edges: EDGES,
  flows: FLOWS,
  intro: INTRO,
  unmapped: UNCLAIMED,
  repo: 'HUM-CDCH/FREE',
} satisfies ArchitectureData
