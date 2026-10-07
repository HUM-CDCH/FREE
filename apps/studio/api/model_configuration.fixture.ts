import type { ModelConfigurationStore } from 'db'

/**
 * An in-memory stand-in for PostgreSQL's ModelConfigurationStore, keyed by Researcher Account. Like the row lock,
 * one account's applies run one at a time and each sees the previous commit; a `next` that throws commits nothing.
 */
export function inMemoryModelConfigurations(
  initial: Record<string, unknown> = {},
): ModelConfigurationStore & { documents: Map<string, unknown> } {
  const documents = new Map<string, unknown>(Object.entries(initial))
  const tails = new Map<string, Promise<unknown>>()
  return {
    documents,
    async read(researcherAccountId) {
      return structuredClone(documents.get(researcherAccountId) ?? null)
    },
    apply(researcherAccountId, next) {
      const applied = (tails.get(researcherAccountId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const document = await next(structuredClone(documents.get(researcherAccountId) ?? null))
          if (document === null || document === undefined)
            throw new Error('A Model Configuration apply must store a document.')
          documents.set(researcherAccountId, structuredClone(document))
          return document
        })
      tails.set(researcherAccountId, applied)
      return applied
    },
  }
}
