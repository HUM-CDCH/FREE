import type { SchemaInstructions } from './useSchemaInstructions'

type MessageClass = (role: 'user' | 'assistant') => string

const ACKNOWLEDGEMENTS: React.ReactNode[] = [
  <>Got it — recorded for schema generation.</>,
  <>Noted. That's added to the instructions guiding schema generation.</>,
  <>Recorded — this'll factor into the generated schema.</>,
  <>Good, saved. Keep adding instructions, or generate the schema whenever you're ready.</>,
]

function acknowledgement(index: number): React.ReactNode {
  return ACKNOWLEDGEMENTS[index % ACKNOWLEDGEMENTS.length]
}


/** Pre-generation conversation over the same instruction state used by the Regenerate dialog: the message list only;
 *  the panel's chat drawer scrolls it and composes it. */
export function SchemaInstructionsChat({
  instructions,
  messageClass,
}: {
  instructions: SchemaInstructions
  messageClass: MessageClass
}) {
  return (
    <div className="flex flex-col gap-2">
      {instructions.items.length === 0 && (
        <p className="flex items-center gap-1.5 text-secondary leading-relaxed text-ink-faint">
          Add instructions for schema generation.
          <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-overline font-semibold uppercase tracking-wide text-ink-faint">
            Optional
          </span>
        </p>
      )}
      {instructions.items.map((instruction, index) => (
        <div key={instruction.id} className="flex flex-col gap-1">
          <div className={messageClass('user')}>{instruction.text}</div>
          <div className="flex items-center gap-1.5 self-start pl-1 text-overline text-ink-faint">
            <span>Message {index + 1} of {instructions.items.length}</span>
            <button
              type="button"
              className="grid size-6 cursor-pointer place-items-center font-semibold outline-none hover:text-danger"
              title="Remove this instruction"
              onClick={() => instructions.remove(instruction.id)}
            >
              ✗
            </button>
          </div>
          <div className={messageClass('assistant')}>{acknowledgement(index)}</div>
        </div>
      ))}
    </div>
  )
}

/** Compact post-generation editor for the instructions sent by Regenerate. */
export function SchemaInstructionsDrawer({
  instructions,
}: {
  instructions: SchemaInstructions
}) {
  return (
    <div className="flex min-h-0 flex-col border-b border-line bg-canvas">
      <div className="scrollbar-subtle max-h-40 min-h-0 overflow-y-auto px-3.5 py-2">
        {instructions.items.length === 0 ? (
          <p className="text-compact leading-relaxed text-ink-faint">No instructions yet — add one below.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {instructions.items.map((instruction) => (
              <li
                key={instruction.id}
                className="flex items-start gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-compact leading-snug text-ink"
              >
                <span className="min-w-0 flex-1">{instruction.text}</span>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer font-semibold text-ink-faint outline-none hover:text-danger"
                  title="Remove this instruction"
                  onClick={() => instructions.remove(instruction.id)}
                >
                  ✗
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3.5 py-2">
        <input
          className="min-w-0 flex-1 bg-transparent font-sans text-xs text-ink outline-none placeholder:text-ink-faint"
          placeholder={'Add a generation instruction (e.g. "Focus on names, dates, and locations")…'}
          value={instructions.draft}
          onChange={(event) => instructions.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              instructions.send()
            }
          }}
        />
        <button
          type="button"
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40"
          disabled={!instructions.draft.trim()}
          onClick={instructions.send}
        >
          ↑
        </button>
      </div>
    </div>
  )
}
