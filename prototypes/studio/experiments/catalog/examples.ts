/** Synthetic examples, not entries or answers from Beier. Uses the model's advertised examples tokens. */
import { fields } from './schema.js'

export function exampleBlock(template: Record<string, unknown>): string {
  const recordTemplate = (template.records as Record<string, unknown>[] | undefined)?.[0]
  if (!recordTemplate || !('catalog_number' in recordTemplate)) return ''
  const joint = 'evidence' in recordTemplate
  const hasStart = 'start_anchor' in recordTemplate
  const inputs = '[E1] 901. Musterdorf. Fdpl. 2. Sandgrube. Mbl. 9999 (0000).\n[E2] FA: G. Rechteckige Steinkiste; N-S.\n[E3] 902. Nebenort, OT Westdorf. Fdpl. u. Mbl. 9998 (0001). FA: EF.'
  const values = [
    { catalog_number: 901, locality: 'Musterdorf', locality_part: null, findspot: '2. Sandgrube', map_sheet: 9999, find_type: 'G', burial_axis: 'N-S' },
    { catalog_number: 902, locality: 'Nebenort', locality_part: 'Westdorf', findspot: 'u.', map_sheet: 9998, find_type: 'EF', burial_axis: null },
  ]
  const records = values.map((value, i) => ({ ...value,
    ...(joint ? { evidence: Object.fromEntries(fields.map(f => [f, value[f] === null ? 'NONE' : i === 1 ? 'E3' : ['find_type', 'burial_axis'].includes(f) ? 'E2' : 'E1'])) } : {}),
    ...(hasStart ? { start_anchor: i === 0 ? 'E1' : 'E3' } : {}),
  }))
  return `【examples_start】\n【example_input_start】${inputs}【example_input_end】\n【example_output_start】${JSON.stringify({records})}【example_output_end】\n【examples_end】\n`
}
