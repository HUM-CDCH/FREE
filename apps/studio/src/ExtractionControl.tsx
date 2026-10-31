import type { DurableReader } from './durableReader'
import { useDurableReading } from './durableReader'
import { resultSchemaLabel } from './resultSchema'
import Button from './ui/Button'

type Action='pause'|'resume'|'retry'
/** Only the control needs the reader's input selection; reading progress need not render the whole workspace. */
export function ExtractionControl({reader,control,busy,onCommand}:{
  reader:DurableReader|null;control:{label:string;action:Action|null};busy:boolean;onCommand:(action:Action)=>void
}) {
  const state=useDurableReading(reader)?.state
  const active=state?.schemaRevisions?.find(revision=>revision.schemaRevisionId===state.selection.schemaRevisionId)
  const pending=state?.schemaRevisions?.find(revision=>revision.schemaRevisionId===state.pendingSelection?.schemaRevisionId)
  const continuing=control.action==='resume'||control.action==='retry'
  const hint=control.action==='pause'?'Pause after the calls in flight; their work is saved'
    :!continuing?undefined
      :state?.pendingSelection?`Apply or discard the pending inputs${pending?` (${resultSchemaLabel(pending)})`:''} before continuing.`
        :active?`Continue this extraction with ${resultSchemaLabel(active)}. Changes to the current schema do not change its saved inputs.`
          :'Continue this extraction with its saved inputs.'
  return <Button variant={continuing?'positive':'secondary'} size="md" className="min-w-43 justify-center tabular-nums"
    disabled={busy||control.action===null||Boolean(continuing&&state?.pendingSelection)} title={hint} aria-description={hint}
    onClick={()=>control.action&&onCommand(control.action)}>{control.label}</Button>
}
