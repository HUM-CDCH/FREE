import { z } from 'zod'
import {
  activeSettingsSchema,
  articleSettingsIssues,
  extractionMethodIntentSchema,
  settingsFit,
  type ArticleSettings,
} from 'extraction/extraction-method'
import {
  extractionModelChoiceSchema,
  extractionModelKeySchema,
} from './modelConfig.contract.js'

export { extractionModelChoiceSchema, type ExtractionModelChoice } from './modelConfig.contract.js'

export const extractionStrategySchema = z.enum(['ARTICLE', 'CATALOG'])
export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>

const requestUuid = z.uuid().transform((value) => value.toLowerCase())

/** A numbered-catalogue recipe reference (`id@version`), chosen per Catalog Extraction; kei-exp owns the recipes. */
export const catalogRecipeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/)

/** The two roles an Extraction's model calls split into: `fields` reads values off the source, `reasoning` decides over
 *  labelled text (record starts, grounding, arbitration). kei-exp routes each role to one of its deployment's models. */
export const extractionModelRoleSchema = z.enum(['fields', 'reasoning'])
export type ExtractionModelRole = z.infer<typeof extractionModelRoleSchema>

/** kei-exp's `GET /api/extraction-models`: the deployment's extraction models, the roles each may take and whether its
 *  server serves it now, and the default key per role. */
export const extractionModelListingSchema = z
  .object({
    defaults: z.object({ fields: extractionModelKeySchema, reasoning: extractionModelKeySchema }).strict(),
    models: z.array(
      z
        .object({
          key: extractionModelKeySchema,
          repo: z.string().min(1),
          roles: z.array(extractionModelRoleSchema),
          reachable: z.boolean(),
          serving: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
export type ExtractionModelListing = z.infer<typeof extractionModelListingSchema>

export const extractionRequestSchema = z
  .object({
    id: requestUuid,
    sourceRepresentationRevisionId: requestUuid,
    schemaRevisionId: requestUuid,
    strategy: extractionStrategySchema,
    catalogRecipe: catalogRecipeSchema.optional(),
    /** The saved method the start view showed: the Extraction Model Choice and this strategy's settings. Admission
     *  refuses it when the account's saved method changed since, and pins it otherwise. */
    method: extractionMethodIntentSchema,
    /** The page the researcher was reading when Run was clicked (one-based): the order kei reads records in, never
     *  which records. Absent when the view names none. */
    startPage: z.number().int().positive().optional(),
  })
  .strict()
  .refine((request) => request.catalogRecipe === undefined || request.strategy === 'CATALOG', {
    path: ['catalogRecipe'],
    message: 'A recipe applies to a Catalog Extraction only.',
  })
  .refine((request) => settingsFit(request.strategy, request.catalogRecipe ?? null, request.method.settings), {
    path: ['method', 'settings'],
    message: 'The saved settings do not match this Extraction Strategy.',
  })
  .superRefine(methodRuleIssues)

/** A direct request gets the same field-addressed refusals as the Advanced tab (design §3): the contract's own rules. */
export function methodRuleIssues(request: { method: z.output<typeof extractionMethodIntentSchema> }, context: z.RefinementCtx): void {
  const settings = request.method.settings
  const article: ArticleSettings | null = 'article' in settings ? settings.article : null
  if (!article) return
  for (const issue of articleSettingsIssues(article))
    context.addIssue({ code: 'custom', path: ['method', 'settings', 'article', issue.path], message: issue.message })
}

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>
export type ExtractionRequestInput = z.input<typeof extractionRequestSchema>

/** A named immutable result/decision cut of a durable Extraction. */
export const finalizedReviewSchema = z
  .object({ snapshotVersion: z.number().int().positive(), feedbackVersion: z.number().int().nonnegative(), createdAt: z.iso.datetime() })
  .strict()
export type FinalizedReview = z.infer<typeof finalizedReviewSchema>

/** The durable lifecycle a coordination head reports (ADR 0017). */
export const extractionExecutionStatusSchema = z.enum(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED'])
export type ExtractionExecutionStatus = z.infer<typeof extractionExecutionStatusSchema>

/**
 * One durable Extraction: its pins, its lifecycle and its latest finalized cut. Saved values, decisions, history and
 * exports are read through `/api/extractions/{id}/durable`.
 */
export const extractionAttemptSchema = z
  .object({
    extractionId: z.uuid(),
    sourceDocumentId: z.uuid(),
    sourceRepresentationRevisionId: z.uuid(),
    schemaRevisionId: z.uuid(),
    strategy: extractionStrategySchema,
    /** The numbered-catalogue recipe a Catalog Extraction was admitted with; null for generic Catalog and for Article. */
    catalogRecipe: catalogRecipeSchema.nullable(),
    /** The admitted Extraction Model Choice; null when every role kept kei-exp's deployment default. */
    requestedModels: extractionModelChoiceSchema.nullable(),
    /** The settings admitted with the Extraction. */
    requestedSettings: activeSettingsSchema.nullable(),
    executionStatus: extractionExecutionStatusSchema,
    /** The latest finalization of any of its cuts; later work stays separate and live inspection shows the live cut. */
    finalizedReview: finalizedReviewSchema.nullable(),
    batchExtractionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.catalogRecipe !== null && attempt.strategy !== 'CATALOG')
      context.addIssue({ code: 'custom', path: ['catalogRecipe'], message: 'A recipe applies to a Catalog Extraction only.' })
  })

export type ExtractionAttempt = z.infer<typeof extractionAttemptSchema>

/** `GET /api/extractions/{id}`: one durable Extraction. */
export const extractionReadResponseSchema = z.object({ extraction: extractionAttemptSchema }).strict()
