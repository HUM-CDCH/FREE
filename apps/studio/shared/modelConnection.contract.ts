import { CANONICAL_UUID } from 'studio-configuration'
import { z } from 'zod'

/** Connection and key primitives. The signed-out page's key store and sign-out read these, so this module imports
 *  nothing a signed-out browser cannot load (see `server/signedOutModules.test.ts`). */

export const PROVIDER_KINDS = [
  'ollama',
  'openai',
  'anthropic',
  'google',
  'codex-cli',
  'claude-code',
  'openai-compatible',
  'vllm',
] as const
export const providerKindSchema = z.enum(PROVIDER_KINDS)
export type ProviderKind = z.infer<typeof providerKindSchema>

export const uuidSchema = z
  .string()
  .regex(CANONICAL_UUID, 'Must be a canonical lowercase UUID.')

export const modelConnectionSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1, 'Must not be empty.'),
    provider: providerKindSchema,
    baseUrl: z.string().min(1).nullable(),
    /** Whether calls to this connection carry a key. The key stays in the researcher's browser and, while a call needs
     *  it, in Studio's memory; never in this document. Managed providers always have one; deployment connections never. */
    hasKey: z.boolean(),
  })
  .strict()
export type ModelConnection = z.infer<typeof modelConnectionSchema>

/** The longest model key Studio accepts: in a probe, in the key handoff and in this browser's key store. */
export const MODEL_KEY_MAX_LENGTH = 8192

/** Printable ASCII (0x20–0x7E) with no space at either end. A key that is no valid header value never reaches a
 *  provider client, whose runtime error would quote the whole `Bearer <key>` header. */
const MODEL_KEY_CHARACTERS = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/** A model key as Studio accepts it: in a probe, in the key handoff and in this browser's key store. */
export const modelKeySchema = z.string().min(1).max(MODEL_KEY_MAX_LENGTH).regex(MODEL_KEY_CHARACTERS)

/** Why Studio would refuse a typed, non-empty key, or `null` when it would accept it. */
export function modelKeyIssue(key: string): string | null {
  if (key.length > MODEL_KEY_MAX_LENGTH) return `A key can be at most ${MODEL_KEY_MAX_LENGTH} characters.`
  if (!MODEL_KEY_CHARACTERS.test(key)) return 'A key can contain only printable ASCII characters, with no spaces at either end.'
  return null
}
