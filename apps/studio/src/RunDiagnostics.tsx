import type { DurablePage } from 'extraction/durable-types'
import { shownValue } from './reviewVocabulary'

/** The Article resolution issues review shows. Their `detail` is a JSON string naming the field (`path`, from the
 *  record) and, for a list, each item by its index in the list the snapshot kept. */
const SHOWN:ReadonlySet<string>=new Set(['uncertain_items','dropped_items','resolved_value','resolution_not_applied','resolution_failed','resolution_exceeds_budget'])
type Issue={code:string;detail:string;record?:number|null;path?:(string|number)[]|null}
type Entry={key:string;record:string;text:string}

const at=(root:unknown,path:readonly (string|number)[])=>path.reduce<unknown>((value,part)=>
  value!==null&&typeof value==='object'?(value as Record<string|number,unknown>)[part]:undefined,root)

/** One entry per occurrence: an item is named by its place, never by its value, so equal items stay apart. */
function entries(issue:Issue,position:number,values:DurablePage['values']):Entry[] {
  if(issue.code==='resolution_failed'||issue.code==='resolution_exceeds_budget')return [{key:String(position),record:'[]',
    text:`assembled values retained; resolution not applied (${issue.code==='resolution_failed'?'resolution reply failed':'request exceeds budget'})`}]
  let detail:{path?:unknown;items?:{index:number;of:string;label:string}[];dropped?:unknown[];of?:string[];chosen?:unknown;alternatives?:unknown[]}
  try {detail=JSON.parse(issue.detail)} catch {return []}
  if(!Array.isArray(detail.path)||!Array.isArray(issue.path))return []
  const field=detail.path.join(' › '),record=JSON.stringify(issue.path),key=`${position}:${record}`
  const saved=values.find(value=>JSON.stringify(value.path)===JSON.stringify(issue.path!.slice(0,3)))
  const list=saved?at(saved.modelValue,detail.path.slice(1)):undefined
  const given=(of:string|undefined)=>of?`, given to “${of}”`:''
  switch(issue.code) {
    case 'resolution_not_applied': return [{key,record,text:`${field} · assembled values retained; resolution not applied (invalid list reply)`}]
    case 'uncertain_items': return (detail.items??[]).map(item=>({key:`${key}:${item.index}`,record:JSON.stringify([...issue.path!,item.index]),
      text:`${field} · item ${item.index+1}${Array.isArray(list)&&item.index<list.length?`: ${shownValue(list[item.index])}`:''} · kept, not settled (${item.label}${given(item.of)})`}))
    case 'dropped_items': return (detail.dropped??[]).map((item,index)=>({key:`${key}:${index}`,record,
      text:`${field} · left out: ${shownValue(item)}${given(detail.of?.[index])}`}))
    default: return [{key,record,text:`${field} · picked ${shownValue(detail.chosen)} among ${(detail.alternatives??[]).map(shownValue).join(' / ')}`}]
  }
}

/** The run diagnostics of the snapshot shown, and only of it: a snapshot without them shows none. */
export function RunDiagnostics({page}:{page:DurablePage}) {
  const coverage=page.coverage as {diagnostics?:{issues?:unknown};sourceGeneration?:unknown;finalizedAttempt?:{attemptId?:string;generation?:number}}|null
  const issues=Array.isArray(coverage?.diagnostics?.issues)?coverage.diagnostics.issues as Issue[]:[]
  const shown=issues.flatMap((issue,position)=>SHOWN.has(issue?.code)&&typeof issue.detail==='string'?entries(issue,position,page.values):[])
  if(shown.length===0)return null
  const attempt=coverage?.finalizedAttempt
  return <section aria-label="Run diagnostics" className="rounded-md border border-line p-3 text-secondary">
    <h3 className="m-0 font-semibold">Run diagnostics</h3>
    <p className="m-0 text-compact text-ink-muted">From saved results {page.snapshotVersion}
      {coverage?.sourceGeneration!=null?` · source generation ${String(coverage.sourceGeneration)}`:''}
      {attempt?.attemptId?` · attempt ${attempt.attemptId.slice(0,8)}, generation ${attempt.generation}`:''}</p>
    <ul className="m-0 mt-1 list-disc pl-5">{shown.map(entry=><li key={entry.key} data-diagnostic-path={entry.record}>{entry.text}</li>)}</ul>
  </section>
}
