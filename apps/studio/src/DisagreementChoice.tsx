import { useState } from 'react'
import { shownValue, type RailRow } from './reviewVocabulary'
import { Button } from './ui'

/** A choice is explicit at every disagreeing place; nothing starts selected. */
export default function DisagreementChoice({parts,onChoose}:{parts:NonNullable<RailRow['disagreement']>;onChoose:(ids:string[])=>void}) {
  const [picks,setPicks]=useState<Record<number,string>>({})
  const choose=(part:number,id:string)=> {
    const next={...picks,[part]:id}
    setPicks(next)
    if(parts.every((entry,index)=>entry.alternatives.some(alternative=>alternative.id===next[index])))
      onChoose(parts.map((_,index)=>next[index]))
  }
  return <div className="space-y-2">
    {parts.map((part,index)=><fieldset key={part.part} className="m-0 min-w-0 space-y-2 border-0 p-0">
      {part.part && <legend className="font-mono text-secondary text-ink">{part.part}</legend>}
      {part.alternatives.map(alternative=><div key={alternative.id} className="flex items-start justify-between gap-2 rounded-md border border-line p-2">
        <div className="min-w-0"><p className="m-0 break-words text-content text-ink">{shownValue(alternative.value)}</p>
          <p className="m-0 text-compact text-ink-muted">read in {alternative.pages??'source'} · not checked</p></div>
        <Button aria-label={`Use ${shownValue(alternative.value)}`} aria-pressed={picks[index]===alternative.id}
          onClick={()=>choose(index,alternative.id)}>Use this</Button>
      </div>)}
    </fieldset>)}
  </div>
}
