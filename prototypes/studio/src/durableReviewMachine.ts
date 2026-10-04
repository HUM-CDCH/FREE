import { assign, fromPromise, setup } from 'xstate'
import type { DurablePage } from 'extraction/durable-types'
import { durableRequest, durableRoot } from './durableExtractionApi'

type Value=DurablePage['values'][number]
type Draft={value:unknown;included:boolean;evidence:{anchorId:string;occurrenceIds:string[]}[]}
export function reviewDraft(value:Value):Draft {
  const decision=value.correction?.decision
  return {value:decision?.action==='EDITED'?decision.value:value.modelValue,
    included:decision?.included??true,evidence:decision?.evidence??[]}
}
/** Polling changes the view; it never replaces a researcher's open draft. */
export const durableReviewMachine=setup({
  types:{} as {context:{extractionId:string;value:Value;snapshotVersion:number;draft:Draft;error:string|null};input:{extractionId:string;value:Value;snapshotVersion:number};events:{type:'edit';draft:Draft}|{type:'save';action:'APPROVED'|'EDITED'|'REJECTED'|'PENDING'}|{type:'cancel'}|{type:'refresh'}},
  actors:{loadSaved:fromPromise(async({input}:{input:{extractionId:string;valueId:string;snapshotVersion:number}})=>durableRequest<DurablePage>(`${durableRoot(input.extractionId)}/values/${encodeURIComponent(input.valueId)}?snapshotVersion=${input.snapshotVersion}`)),save:fromPromise(async({input}:{input:{extractionId:string;valueId:string;body:unknown}})=>durableRequest(`${durableRoot(input.extractionId)}/values/${encodeURIComponent(input.valueId)}`,input.body))},
}).createMachine({
  id:'durableReview',initial:'viewing',
  context:({input})=>({...input,draft:reviewDraft(input.value),error:null}),
  states:{
    viewing:{on:{edit:{target:'editing',actions:assign({draft:({event})=>event.draft,error:null})},save:{target:'saving'}}},
    editing:{on:{edit:{actions:assign({draft:({event})=>event.draft})},save:{target:'saving'},refresh:{target:'reloading'},cancel:{target:'viewing',actions:assign({error:null})}}},
    saving:{invoke:{src:'save',input:({context,event})=>({extractionId:context.extractionId,valueId:context.value.id,body:{expectedRevision:context.value.correction?.revision??context.value.historicalCorrection?.revision??0,snapshotVersion:context.snapshotVersion,action:event.type==='save'?event.action:'PENDING',value:context.draft.value,included:context.draft.included,evidence:context.draft.evidence}}),onDone:{target:'saved'},onError:{target:'editing',actions:assign({error:({event})=>event.error instanceof Error?event.error.message:'Unable to save. Your draft is still here.'})}}},
    reloading:{invoke:{src:'loadSaved',input:({context})=>({extractionId:context.extractionId,valueId:context.value.id,snapshotVersion:context.snapshotVersion}),onDone:{target:'editing',actions:assign({value:({event,context})=>event.output.values[0]??context.value,error:null})},onError:{target:'editing',actions:assign({error:'Unable to reload the saved decision. Your draft is still here.'})}}},
    saved:{type:'final'},
  },
})
