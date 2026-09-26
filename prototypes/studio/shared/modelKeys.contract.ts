import { z } from 'zod'
import {
  modelKeySchema,
  providerKindSchema,
  uuidSchema,
  type ModelConnection,
  type ProviderKind,
} from './modelConfig.contract.js'

/** The provider and API base a key was saved or sent for. A key is used only while its connection still has both. */
export type ModelKeyAddress = Readonly<{ provider: ProviderKind; baseUrl: string | null }>

/** Whether a key held at `address` may be used for `connection`: never for another provider or another API base. */
export function sameModelKeyAddress(
  address: ModelKeyAddress,
  connection: Pick<ModelConnection, 'provider' | 'baseUrl'>,
): boolean {
  return address.provider === connection.provider && address.baseUrl === connection.baseUrl
}

export const modelKeyEntrySchema = z
  .object({ provider: providerKindSchema, baseUrl: z.string().min(1).nullable(), key: modelKeySchema })
  .strict()

/** `PUT /api/model-keys`: this browser's keys for `account`, each under its connection ID; `null` removes one. */
export const modelKeysRequestSchema = z
  .object({ account: uuidSchema, keys: z.record(uuidSchema, modelKeyEntrySchema.nullable()) })
  .strict()
