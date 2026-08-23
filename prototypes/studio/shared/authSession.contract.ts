import { z } from 'zod'

export const anonymousSessionSchema = z
  .object({ authenticated: z.literal(false) })
  .strict()

export const authenticatedSessionSchema = z
  .object({
    authenticated: z.literal(true),
    account: z
      .object({
        id: z.string(),
        email: z.string(),
        mustChangePassword: z.boolean(),
      })
      .strict(),
  })
  .strict()

export const authSessionSchema = z.discriminatedUnion('authenticated', [
  anonymousSessionSchema,
  authenticatedSessionSchema,
])

export type AuthSession = z.infer<typeof authSessionSchema>
export type AuthenticatedSession = Extract<AuthSession, { authenticated: true }>
