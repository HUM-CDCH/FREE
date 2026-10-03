import { z } from 'zod'

const count = z.number().int().nonnegative()
/** Native predictions and scores, apart from FREE's verified candidates. Values are never repaired. */
export const nativeFieldsSchema = z.object({
  backend: z.literal('gliformer'),
  windows: z.array(z.object({
    entry: z.string(), record_start: count, record_count: count,
    ranges: z.array(z.object({ segment: z.string(), start: count, end: count })),
    input_text: z.string(), input_tokens: count,
    identity: z.record(z.string(), z.string()),
    output: z.record(z.string(), z.json()), diagnostics: z.record(z.string(), z.json()),
  })),
})
