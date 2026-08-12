## Context

`SchemaPanel` manages schema nodes as a `SchemaNode` tree. Leaf nodes (no `children`) represent scalar fields; group nodes (`children !== undefined`) represent nested objects or arrays. Currently `SchemaNode` carries only `id`, `name`, `type`, and `children`. Researchers have no way to annotate the semantic intent of a group, which limits what the extraction model can infer about ambiguous nested structures.

NuExtract3 in `structured` mode (used for extraction) has a `【instructions】` slot that is rendered before the template — it is the canonical place for free-text extraction guidance per the NuExtract jinja template.

## Goals / Non-Goals

**Goals:**
- Let researchers attach a human-readable description to any group node (object or array)
- Surface descriptions to NuExtract via the `【instructions】` slot, not the template JSON
- Provide two UI entry points: an ℹ icon in the fields view, and inline `_description` keys in an editable JSON view
- Keep the extraction template clean — no `_description` keys reach the model's template slot

**Non-Goals:**
- Descriptions on leaf nodes (not needed; leaf nodes have a type string that already conveys intent)
- Persisting schema + descriptions to a backend (no persistence layer exists yet)
- Validation or length-limiting of descriptions

## Decisions

### 1. Storage: `SchemaNode.description?: string`

Descriptions live in the `SchemaNode` tree (UI state only). They are not part of the template object sent to or received from the backend.

*Alternative considered*: storing descriptions as `_description` keys inside the template record. Rejected because it pollutes the schema contract and requires every consumer to know to strip them.

### 2. JSON view encoding: `_description` as a display-only convention

The JSON tab renders a "display template" that includes `_description` keys for group nodes that have a description. This gives researchers a single, familiar surface (JSON) to read and edit descriptions alongside the schema structure.

- `nodesToTemplate(nodes)` → display version, includes `_description`
- `nodesToTemplateForExtraction(nodes)` → extraction version, strips `_description` recursively; this is what gets passed to `/api/extract`

*Alternative considered*: separate UI-only editor for descriptions, JSON view stays pure. Rejected because researchers may want to bulk-edit schema + descriptions in one JSON paste.

### 3. Model delivery: `【instructions】` slot

When extraction runs, all group descriptions are compiled into a structured paragraph and prepended to the instructions string passed to the model command builder. Format:

```
Field descriptions:
- <group.name>: <description>
- <parent.child>: <description>
```

This is injected into the existing `instructions` parameter of the extraction model call. No changes to the NuExtract prompt template or the backend are needed — the instructions slot already exists.

*Alternative considered*: embedding `_description` in the template JSON sent to the model. Rejected because NuExtract would attempt to extract a `_description` field in the result.

### 4. JSON tab editing

The JSON tab currently renders `<pre>`. Adding an Edit button switches it to `<textarea>`. On save:
1. Parse JSON
2. Call `templateToNodes` (which reads `_description` keys into `SchemaNode.description`)
3. Update nodes state and call `onTemplateChange`

Parse errors surface inline; the textarea stays open until resolved or cancelled.

### 5. ℹ icon behavior

- Icon appears only on group node rows (leaf rows unchanged)
- Clicking toggles an inline `<input>` below the row (single line — descriptions should be short hints, not paragraphs)
- Blurring the input saves the description to state
- Icon is filled/colored when description is non-empty, dimmed when empty

## Risks / Trade-offs

- **Instructions slot length**: Very large schemas with many descriptions could produce a long instructions string. Not a concern for the current prototype scale.
- **`nodesToTemplateForExtraction` divergence**: Two template functions must be kept in sync. Mitigated by keeping the extraction variant a thin wrapper that calls the display variant then strips `_description` keys recursively.
- **JSON round-trip fidelity**: Editing JSON and saving re-runs `templateToNodes`, which re-generates `id`s (uses `mkId()`). Drag state referencing old ids is reset. Acceptable trade-off for an editable JSON surface.
