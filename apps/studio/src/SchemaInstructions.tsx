import type { SchemaInstructions } from './useSchemaInstructions'

type MessageClass = (role: 'user' | 'assistant') => string

const removeClass = 'grid size-6 shrink-0 cursor-pointer place-items-center font-semibold outline-none hover:text-danger'

/** One kept instruction or answered question, where the conversation shows it: an instruction is kept for
 *  generation, a note rather than a turn; a question is a turn, shown with its answer, and generation never reads it. */
export function InstructionItem({ instructions, id, messageClass }: {
  instructions: SchemaInstructions
  id: string
  messageClass: MessageClass
}) {
  const instruction = instructions.items.find((item) => item.id === id)
  if (!instruction) return null
  if (instruction.answer !== undefined)
    return (
      <div className="flex flex-col gap-1">
        <div className={`${messageClass('user')} [overflow-wrap:anywhere]`}>{instruction.text}</div>
        <div className="flex items-center gap-1.5 self-end pr-1 text-overline text-ink-faint">
          <span>Question · not used for generation</span>
          <button type="button" className={removeClass} title="Remove this question" onClick={() => instructions.remove(instruction.id)}>✗</button>
        </div>
        <div className={`${messageClass('assistant')} whitespace-pre-wrap [overflow-wrap:anywhere]`}>{instruction.answer}</div>
      </div>
    )
  // Each instruction's number among the instructions alone.
  const number = instructions.items.filter(({ answer }) => answer === undefined).findIndex((item) => item.id === id) + 1
  return (
    <div role="note" aria-label={`Instruction ${number}`}
      className="flex max-w-[88%] flex-col self-end rounded-[3px] border border-dashed border-accent/60 bg-accent-ghost py-1 pl-3 pr-1">
      <div className="flex items-center gap-1.5 text-overline font-semibold text-accent">
        <span className="min-w-0 flex-1">{`Instruction ${number} of ${instructions.count} · for generation`}</span>
        <button type="button" className={removeClass} title="Remove this instruction" onClick={() => instructions.remove(instruction.id)}>✗</button>
      </div>
      <p className="pr-2 pb-0.5 text-secondary leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{instruction.text}</p>
    </div>
  )
}

/** A message sent before the first template whose reply is still coming. */
export function PendingAsk({ asking, messageClass }: { asking: string; messageClass: MessageClass }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={`${messageClass('user')} [overflow-wrap:anywhere]`}>{asking}</div>
      <div className={`${messageClass('assistant')} text-ink-faint`}>Reading the document…</div>
    </div>
  )
}

/** Pre-generation conversation over the same instruction state used by the Regenerate dialog, for a panel showing no
 *  other conversation: the instructions and questions in the order said, then `asking`, the message whose reply is
 *  still coming. The panel scrolls and composes it. */
export function SchemaInstructionsChat({
  instructions,
  messageClass,
  asking = null,
}: {
  instructions: SchemaInstructions
  messageClass: MessageClass
  asking?: string | null
}) {
  if (instructions.items.length === 0 && asking === null) return null
  return (
    <div className="flex flex-col gap-2">
      {instructions.items.map(({ id }) => <InstructionItem key={id} instructions={instructions} id={id} messageClass={messageClass} />)}
      {asking !== null && <PendingAsk asking={asking} messageClass={messageClass} />}
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
        {instructions.count === 0 ? (
          <p className="text-compact leading-relaxed text-ink-faint">No instructions yet — add one below.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {instructions.items.filter((instruction) => instruction.answer === undefined).map((instruction) => (
              <li
                key={instruction.id}
                className="flex items-start gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-compact leading-snug text-ink"
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{instruction.text}</span>
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
