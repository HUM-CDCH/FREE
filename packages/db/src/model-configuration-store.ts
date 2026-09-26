import { db, type Database } from './prisma/db.js'

/**
 * One Researcher Account's Model Configuration document. Studio validates it before every write; keys never enter
 * it. The store only guarantees that one account's applies run one at a time, each reading the document the
 * previous one committed.
 */
export type ModelConfigurationStore = {
  /** The account's document, or null before its first apply. */
  read(researcherAccountId: string): Promise<unknown | null>
  /**
   * Replaces the account's document in one transaction that holds the configuration row's lock. `next` receives the
   * committed document (null before the first apply) and returns the one to store; when it throws, nothing is
   * written and the error propagates.
   */
  apply(
    researcherAccountId: string,
    next: (previous: unknown | null) => unknown | Promise<unknown>,
  ): Promise<unknown>
}

export function createModelConfigurationStore(database: Database = db): ModelConfigurationStore {
  return {
    async read(researcherAccountId) {
      const row = await database.orm.public.ModelConfiguration.select('document').first({ researcherAccountId })
      return row?.document ?? null
    },
    apply(researcherAccountId, next) {
      return database.transaction(async ({ orm }) => {
        // Inserts the row on the account's first apply, otherwise takes its lock (ON CONFLICT DO UPDATE); a
        // concurrent first insert makes this statement wait for that transaction. The lock statement never writes
        // `document`: a value read before the lock could overwrite a concurrent commit.
        const locked = await orm.public.ModelConfiguration.upsert({
          create: { researcherAccountId },
          update: { updatedAt: new Date() },
        })
        const document = await next(locked.document ?? null)
        await orm.public.ModelConfiguration.where({ researcherAccountId }).update({ document, updatedAt: new Date() })
        return document
      })
    },
  }
}
