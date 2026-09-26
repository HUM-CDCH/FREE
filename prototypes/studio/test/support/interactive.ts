import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { CanonicalPackageStore } from 'db'
import type { ModelKeyCache } from '../../api/_model_keys.js'
import { applyAccountModelConfig } from '../../api/_model_config.js'
import { removeSuggestionSources, seedSuggestionSources, type SeededSuggestionSources } from './suggestionWorkflow.js'

export type InteractiveScope = Readonly<{
  accountId: string
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  /** The seeded rows, for removal. */
  seeded: SeededSuggestionSources
}>

/** One researcher, one project, one Source Document with one revision whose canonical Markdown is `# Source A`,
 *  written through M4's seeding helper (a real canonical package under `packages`). */
export async function seedInteractiveScope(packages: CanonicalPackageStore): Promise<InteractiveScope> {
  const seeded = await seedSuggestionSources(packages, ['A'])
  const [source] = seeded.sources
  if (!source) throw new Error('seedSuggestionSources returned no source.')
  return {
    accountId: seeded.researcherAccountId,
    projectContextId: seeded.projectContextId,
    sourceDocumentId: source.sourceDocumentId,
    sourceRepresentationRevisionId: source.sourceRepresentationRevisionId,
    seeded,
  }
}

export async function removeInteractiveScope(scope: InteractiveScope): Promise<void> {
  await removeSuggestionSources(scope.seeded)
}

export type OwnerRoute = Readonly<{
  provider: 'openai-compatible' | 'vllm'
  baseUrl: string
  modelId: string
  hasKey: boolean
  /** Which routes name the connection; both by default. */
  routes?: ReadonlyArray<'interaction' | 'schemaSuggestion'>
}>

/** Applies a researcher Model Configuration with one connection at `route.baseUrl`, as the page's Apply does. */
export async function configureOwnerRoute(
  accountId: string,
  route: OwnerRoute,
  keys?: Pick<ModelKeyCache, 'retain'>,
): Promise<{ connectionId: string }> {
  const connectionId = randomUUID()
  const routes = route.routes ?? ['interaction', 'schemaSuggestion']
  const target = { connectionId, modelId: route.modelId }
  await applyAccountModelConfig({
    config: {
      connections: [{ id: connectionId, name: 'Scripted model', provider: route.provider, baseUrl: route.baseUrl, hasKey: route.hasKey }],
      routes: {
        schemaSuggestion: routes.includes('schemaSuggestion') ? target : null,
        interaction: routes.includes('interaction') ? target : null,
      },
      extractionModels: {},
      ingestionModels: {},
    },
  }, { researcherAccountId: accountId, ...(keys ? { keys } : {}) })
  return { connectionId }
}

/** Every `<schema>.<table>` in `schemas` with at least one row whose text form holds `needle`. */
export async function databaseHolds(url: string, needle: string, schemas: readonly string[]): Promise<readonly string[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows: tables } = await client.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = ANY($1)`,
      [schemas],
    )
    const holding: string[] = []
    for (const { table_schema, table_name } of tables) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table_schema}"."${table_name}" AS x WHERE x::text LIKE $1`,
        [`%${needle}%`],
      )
      if (rows[0]!.n > 0) holding.push(`${table_schema}.${table_name}`)
    }
    return holding
  } finally {
    await client.end()
  }
}

/** Captures console.* and process.stdout/stderr writes (DBOS's logger writes there) until `restore()`. */
export function captureOutput(): { text(): string; restore(): void } {
  const chunks: string[] = []
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const
  const originals = Object.fromEntries(levels.map((level) => [level, console[level]])) as Record<typeof levels[number], (...data: unknown[]) => void>
  for (const level of levels) console[level] = (...data: unknown[]) => { chunks.push(data.map(String).join(' ')) }
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  const capture = (chunk: unknown) => { chunks.push(typeof chunk === 'string' ? chunk : String(chunk)); return true }
  process.stdout.write = capture as typeof process.stdout.write
  process.stderr.write = capture as typeof process.stderr.write
  return {
    text: () => chunks.join('\n'),
    restore: () => {
      for (const level of levels) console[level] = originals[level]
      process.stdout.write = stdoutWrite
      process.stderr.write = stderrWrite
    },
  }
}
