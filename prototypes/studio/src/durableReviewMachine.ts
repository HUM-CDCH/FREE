import { assign, fromPromise, setup } from 'xstate'
import type { DurablePage,DurableHistory } from 'extraction/durable-types'
import { durableRequest, durableRoot } from './durableExtractionApi'

type Value=DurablePage['values'][number]
type Draft={value:unknown;included:boolean;evidence:{anchorId:string;occurrenceIds:string[]}[]}
type Action='APPROVED'|'EDITED'|'REJECTED'|'PENDING'
export function reviewDraft(value:Value):Draft {
  const decision=value.correction?.decision
  return {value:decision?.action==='EDITED'?decision.value:value.modelValue,
    included:decision?.included??true,evidence:decision?.evidence??[]}
}
/** Polling changes the view; it never replaces a researcher's open draft. */
export const durableReviewMachine=setup({
  types:{} as {context:{extractionId:string;value:Value;snapshotVersion:number;draft:Draft;action:Action;comparing:boolean;error:string|null};input:{extractionId:string;value:Value;snapshotVersion:number};events:{type:'edit';draft:Draft}|{type:'save';action:Action}|{type:'undo'}|{type:'cancel'}|{type:'refresh'}},
  actions:{chooseAction:assign({action:({event,context})=>event.type==='save'?event.action:context.action})},
  actors:{loadSaved:fromPromise(async({input}:{input:{extractionId:string;valueId:string;snapshotVersion:number}})=>durableRequest<DurablePage>(`${durableRoot(input.extractionId)}/values/${encodeURIComponent(input.valueId)}?snapshotVersion=${input.snapshotVersion}`)),save:fromPromise(async({input}:{input:{extractionId:string;valueId:string;body:unknown}})=>durableRequest(`${durableRoot(input.extractionId)}/values/${encodeURIComponent(input.valueId)}`,input.body)),
    loadPrevious:fromPromise(async({input}:{input:{extractionId:string;value:Value;snapshotVersion:number}})=> {
      const revision=input.value.correction?.revision??input.value.historicalCorrection?.revision??0
      const history=await durableRequest<DurableHistory>(`${durableRoot(input.extractionId)}/history`)
      const previous=history.corrections.find(correction=>correction.valueId===input.value.id&&correction.revision===revision-1)
      if(!previous)return {action:'PENDING' as Action,draft:{value:input.value.modelValue,included:false,evidence:[]}}
      // Reuse the reader's producing-type projection. Undo never restores an
      // incompatible decision or invents child intent from an old whole value.
      const page=await durableRequest<DurablePage>(`${durableRoot(input.extractionId)}/values/${encodeURIComponent(input.value.id)}?snapshotVersion=${input.snapshotVersion}&feedbackVersion=${previous.feedbackVersion}`)
      const value=page.values[0]
      if(!value?.correction)throw new Error('The previous decision does not fit this model version. Open its historical review.')
      return {action:value.correction.decision.action as Action,draft:reviewDraft(value)}
    })},
}).createMachine({
  id:'durableReview',initial:'viewing',
  context:({input})=>({...input,draft:reviewDraft(input.value),action:'PENDING',comparing:false,error:null}),
  states:{
    viewing:{on:{edit:{target:'editing',actions:assign({draft:({event})=>event.draft,error:null})},save:{target:'saving',actions:'chooseAction'},undo:{target:'undoing'}}},
    editing:{on:{edit:{actions:assign({draft:({event})=>event.draft})},save:{target:'saving',actions:'chooseAction'},undo:{target:'undoing'},refresh:{target:'reloading'},cancel:{target:'viewing',actions:assign({error:null})}}},
    undoing:{invoke:{src:'loadPrevious',input:({context})=>({extractionId:context.extractionId,value:context.value,snapshotVersion:context.snapshotVersion}),onDone:{target:'saving',actions:assign({draft:({event})=>event.output.draft,action:({event})=>event.output.action})},onError:{target:'editing',actions:assign({error:({event})=>event.error instanceof Error?event.error.message:'Unable to load the previous decision.'})}}},
    saving:{invoke:{src:'save',input:({context})=>({extractionId:context.extractionId,valueId:context.value.id,body:{expectedRevision:context.value.correction?.revision??context.value.historicalCorrection?.revision??0,snapshotVersion:context.snapshotVersion,action:context.action,value:context.draft.value,included:context.draft.included,evidence:context.draft.evidence}}),onDone:{target:'saved'},onError:{target:'editing',actions:assign({error:({event})=>event.error instanceof Error?event.error.message:'Unable to save. Your draft is still here.'})}}},
    reloading:{invoke:{src:'loadSaved',input:({context})=>({extractionId:context.extractionId,valueId:context.value.id,snapshotVersion:context.snapshotVersion}),onDone:{target:'editing',actions:assign({value:({event,context})=>event.output.values[0]??context.value,comparing:true,error:null})},onError:{target:'editing',actions:assign({error:'Unable to reload the saved decision. Your draft is still here.'})}}},
    saved:{type:'final'},
  },
})
