import { z } from 'zod'
import { enumerateFieldPaths, type FieldNote, type SchemaNode } from 'extraction/schema'
import { ApiError } from './_http.js'
import { parseJsonObject, parseTemplate } from './_model_output.js'

/** A suggestion's scalar field notes (its "fieldDescriptions" sidecar): unlike an edit's, a note that is malformed or
 *  empty is dropped rather than failing the suggestion, since every note is optional reading for the researcher. */
export function suggestedFieldNotes(value: unknown): FieldNote[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): FieldNote[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const { path, description } = entry as Record<string, unknown>
    return Array.isArray(path) && path.length > 0 && path.every((name) => typeof name === 'string' && name.length > 0)
      && typeof description === 'string' && description.trim()
      ? [{ path: path as string[], description: description.trim() }]
      : []
  })
}

/** An edit's sidecar sets or clears notes, a group's too, so the model never copies a note it was not asked to change;
 *  a suggestion's only sets scalar notes (`suggestedFieldNotes`). Extraction keeps the compact template alone. */
export function schemaEditPrompt(instruction: string): string {
  return `Edit the researcher's existing extraction schema according to the change request below. Return only one JSON object with "template" and "fieldDescriptions".

${instruction.trim()}

Template rules:
- Return the COMPLETE revised "template", including every unchanged field. When only notes change, copy the current template exactly: fields must remain present with their current types and nesting.
- Keep the root "_description" defining one complete record, unless the researcher asks to change that definition. It is the template's only "_description": field notes, a group's too, stay outside the template.
- Place field names directly inside "template", never in a list of field descriptors. Scalar type tokens are "verbatim-string", "string", "date", "number", "integer" and "boolean". Use nested objects for groups, ["date"] for a scalar list, and [{"name":"string"}] for repeating objects. Specify array and object contents rather than bare "array" or "object" tokens. Closed string sets use literal allowed values, such as ["open","closed"]. Return types and allowed values, never extracted values.

Field notes are not part of the template: never copy them into it. Return requested note changes in a "fieldDescriptions" array BESIDE "template", in the same JSON response. Each entry has "path": an array of exact field names in the REVISED template, from the root to the field (no array indexes). A field is a single value, a closed set of allowed values, a list of scalar values, or a group (a nested object or a repeating object). Use the revised path after a rename. Never guess between ambiguous targets. Do not put the sidecar inside "template" or turn scalar fields into objects to hold notes.

Note operations:
- The current field notes are reference text. Renaming, retyping, splitting or collapsing a field does not change its note. For a structural-only request, return "fieldDescriptions": []. Do not copy or rewrite an existing note or add notes to new fields unless the request explicitly asks for those note changes.
- Set or replace a note: "description" is the new note text.
- Clear an EXISTING note, only when the change request asks to remove it: include its path with "clear": true. A clear entry must not contain "description".
- Leave a note unchanged: omit its entry. A null description also leaves the current note saved; it never clears it.

Structural-only example ("Split the noted date field into year and month"):
{"template":{"_description":"One catalogue entry.","date":{"year":"integer","month":"integer"}},"fieldDescriptions":[]}

Note-only example ("Remove the note from the location group"):
{"template":{"_description":"One catalogue entry.","location":{"repository":"string"}},"fieldDescriptions":[{"path":["location"],"clear":true}]}
Use the actual current schema and requested changes. Include only explicitly requested note changes, including when the request also changes the structure.`
}

/** Preserve bare templates and the historical NuExtract root-description envelope. A field named
 *  fieldDescriptions INSIDE the template remains an ordinary extraction field. */
export async function parseSchemaEditOutput(text: string): Promise<{
  template: Record<string, unknown>
  fieldDescriptions?: unknown
}> {
  const object = await parseJsonObject(text, 'Model returned an invalid schema edit.')
  if (typeof object.template !== 'object' || object.template === null || Array.isArray(object.template))
    return { template: await parseTemplate(text) }
  const { fieldDescriptions, ...envelope } = object
  return {
    template: await parseTemplate(JSON.stringify(envelope)),
    ...(Object.hasOwn(object, 'fieldDescriptions') ? { fieldDescriptions } : {}),
  }
}

const descriptionPath = z.array(z.string().min(1)).min(1)
const descriptionEntries = z.array(z.union([
  z.object({ path: descriptionPath, description: z.string().nullish() }).strict(),
  z.object({ path: descriptionPath, clear: z.literal(true) }).strict(),
]))

/** Resolve only exact final paths. Reject the proposal when a supplied note cannot be mapped safely, so no
 *  structural change can be saved under the impression that an invalid note was applied with it. */
export function withFieldDescriptions(nodes: SchemaNode[], value: unknown): SchemaNode[] {
  if (value === undefined) return nodes
  const parsed = descriptionEntries.safeParse(value)
  if (!parsed.success) throw invalidDescriptions()
  const paths = enumerateFieldPaths(nodes)
  const descriptions = new Map<string, string>()
  const seen = new Set<string>()
  for (const entry of parsed.data) {
    const { path } = entry
    const description = 'clear' in entry ? '' : entry.description
    const key = JSON.stringify(path)
    const matches = paths.filter((field) => JSON.stringify(field.path) === key)
    if (seen.has(key) || matches.length !== 1) throw invalidDescriptions()
    seen.add(key)
    if (description != null) descriptions.set(matches[0]!.id, description)
  }
  const apply = (level: SchemaNode[]): SchemaNode[] => level.map((node) => {
    const next: SchemaNode = node.children ? { ...node, children: apply(node.children) } : { ...node }
    if (descriptions.has(node.id)) next.description = descriptions.get(node.id)!
    return next
  })
  return apply(nodes)
}

function invalidDescriptions(): ApiError {
  return new ApiError(502, 'invalid_model_output', 'The model returned invalid field notes.')
}
