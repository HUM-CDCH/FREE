import { enumerateFieldPaths, type SchemaNode } from 'extraction/schema'
import { SchemaInstructionsDrawer } from './SchemaInstructions'
import type { SchemaInstructions } from './useSchemaInstructions'
import { Button, ModalDialog } from './ui'

const dialogCls =
  'm-auto w-full max-w-sm rounded-card border border-line bg-surface p-4 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]'

/** Per-field notes set from each row's note action, so Regenerate carries them into the instruction. */
function fieldDescriptionsInstruction(nodes: readonly SchemaNode[]): string {
  const notes = enumerateFieldPaths(nodes)
    .filter(({ node }) => node.description)
    .map(({ path, node }) => `- ${path.join('.')}: ${node.description}`)
  return notes.length ? `Field notes from the current template:\n${notes.join('\n')}` : ''
}

/** Asks before generating the template again from the document: the instructions it is generated with, editable, and
 *  the current template's field notes carried into its instruction. The Template view's menu and the rail's workflow
 *  line both open it, so the two regenerate alike. */
export default function RegenerateDialog({ instructions, nodes, generating, onCancel, onRegenerate }: {
  instructions: SchemaInstructions
  nodes: readonly SchemaNode[]
  generating: boolean
  onCancel: () => void
  onRegenerate: (instruction: string) => void
}) {
  return (
    <ModalDialog className={dialogCls} ariaLabel="Regenerate from the document" onDismiss={onCancel}>
      <h3 className="mb-2 text-secondary font-semibold text-ink">Regenerate from the document</h3>
      <SchemaInstructionsDrawer instructions={instructions} />
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="positive"
          disabled={generating}
          onClick={() => {
            onCancel()
            onRegenerate([instructions.text, fieldDescriptionsInstruction(nodes)].filter(Boolean).join('\n\n'))
          }}
        >
          Regenerate template{instructions.countLabel}
        </Button>
      </div>
    </ModalDialog>
  )
}
