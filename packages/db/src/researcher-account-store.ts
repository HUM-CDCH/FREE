import { db, type Database } from './prisma/db.js'
import { uniqueConstraint } from './project-store.js'

export type ResearcherAccountRecord = {
  id: string
  tenantId: string
  objectId: string
  displayName: string
  createdAt: Date
  updatedAt: Date
}

export type EntraResearcherIdentity = Pick<
  ResearcherAccountRecord,
  'tenantId' | 'objectId' | 'displayName'
>

export type ResearcherAccountStore = {
  findOrCreate(identity: EntraResearcherIdentity): Promise<ResearcherAccountRecord>
  findById(id: string): Promise<ResearcherAccountRecord | null>
}

const ACCOUNT_FIELDS = [
  'id',
  'tenantId',
  'objectId',
  'displayName',
  'createdAt',
  'updatedAt',
] as const

export function createResearcherAccountStore(
  database: Database = db,
): ResearcherAccountStore {
  const findByIdentity = async (
    tenantId: string,
    objectId: string,
  ): Promise<ResearcherAccountRecord | null> =>
    (await database.orm.public.ResearcherAccount.select(
      ...ACCOUNT_FIELDS,
    ).first({ tenantId, objectId })) as ResearcherAccountRecord | null

  const refreshDisplayName = async (
    account: ResearcherAccountRecord,
    displayName: string,
  ): Promise<ResearcherAccountRecord> => {
    if (account.displayName === displayName) return account
    return (await database.orm.public.ResearcherAccount.where({
      id: account.id,
    }).update({ displayName })) as ResearcherAccountRecord
  }

  return {
    async findOrCreate(identity) {
      const existing = await findByIdentity(identity.tenantId, identity.objectId)
      if (existing)
        return refreshDisplayName(existing, identity.displayName)

      try {
        const accountIdentity: EntraResearcherIdentity = {
          tenantId: identity.tenantId,
          objectId: identity.objectId,
          displayName: identity.displayName,
        }
        return (await database.orm.public.ResearcherAccount.create(
          accountIdentity,
        )) as ResearcherAccountRecord
      } catch (error) {
        if (!uniqueConstraint(error)) throw error
        const winner = await findByIdentity(identity.tenantId, identity.objectId)
        if (!winner) throw error
        return refreshDisplayName(winner, identity.displayName)
      }
    },

    async findById(id) {
      return (await database.orm.public.ResearcherAccount.select(
        ...ACCOUNT_FIELDS,
      ).first({ id })) as ResearcherAccountRecord | null
    },
  }
}
