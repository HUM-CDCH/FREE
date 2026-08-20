import { db, type Database } from './prisma/db.js'

export type ResearcherAccountRecord = {
  id: string
  email: string
  passwordHash: string
  mustChangePassword: boolean
  disabledAt: Date | null
  sessionVersion: number
  createdAt: Date
  updatedAt: Date
}

export type ResearcherAccountStore = {
  create(email: string, passwordHash: string): Promise<ResearcherAccountRecord>
  findByEmail(email: string): Promise<ResearcherAccountRecord | null>
  findById(id: string): Promise<ResearcherAccountRecord | null>
  replacePassword(
    id: string,
    expectedSessionVersion: number,
    passwordHash: string,
    mustChangePassword: boolean,
  ): Promise<ResearcherAccountRecord | null>
  disable(
    id: string,
    disabledAt?: Date,
  ): Promise<ResearcherAccountRecord | null>
}

const ACCOUNT_FIELDS = [
  'id',
  'email',
  'passwordHash',
  'mustChangePassword',
  'disabledAt',
  'sessionVersion',
  'createdAt',
  'updatedAt',
] as const

export function normalizeResearcherEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function updateAtSessionVersion(
  database: Database,
  id: string,
  expectedSessionVersion: number,
  update: {
    passwordHash?: string
    mustChangePassword?: boolean
    disabledAt?: Date
  },
): Promise<ResearcherAccountRecord | null> {
  const updated = await database.orm.public.ResearcherAccount.where({
    id,
    sessionVersion: expectedSessionVersion,
  }).update({
    ...update,
    sessionVersion: expectedSessionVersion + 1,
  })
  return updated as ResearcherAccountRecord | null
}

export function createResearcherAccountStore(
  database: Database = db,
): ResearcherAccountStore {
  return {
    async create(email, passwordHash) {
      return (await database.orm.public.ResearcherAccount.create({
        email: normalizeResearcherEmail(email),
        passwordHash,
        mustChangePassword: true,
        disabledAt: null,
        sessionVersion: 0,
      })) as ResearcherAccountRecord
    },

    async findByEmail(email) {
      return (await database.orm.public.ResearcherAccount.select(
        ...ACCOUNT_FIELDS,
      ).first({ email: normalizeResearcherEmail(email) })) as ResearcherAccountRecord | null
    },

    async findById(id) {
      return (await database.orm.public.ResearcherAccount.select(
        ...ACCOUNT_FIELDS,
      ).first({ id })) as ResearcherAccountRecord | null
    },

    replacePassword(
      id,
      expectedSessionVersion,
      passwordHash,
      mustChangePassword,
    ) {
      return updateAtSessionVersion(database, id, expectedSessionVersion, {
        passwordHash,
        mustChangePassword,
      })
    },

    async disable(id, disabledAt = new Date()) {
      for (;;) {
        const current =
          await database.orm.public.ResearcherAccount.select(
            'sessionVersion',
          ).first({ id })
        if (!current) return null
        const updated = await updateAtSessionVersion(
          database,
          id,
          current.sessionVersion,
          { disabledAt },
        )
        if (updated) return updated
      }
    },
  }
}
