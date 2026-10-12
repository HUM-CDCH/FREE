import { useEffect, useRef, useState } from 'react'
import { activeMethod, canonicalExtractionSettings } from 'extraction/extraction-method'
import type { DurableRead } from 'extraction/durable-types'
import type { ExtractionAttempt, ExtractionModelListing } from '../shared/extraction.contract'
import type { ModelConfig } from '../shared/modelConfig.contract'
import { readExtractionModels } from './api'
import { durableRequest, durableRoot } from './durableExtractionApi'
import { beginDurableInputEdit } from './durableInputEditing'
import { AdvancedTab } from './providerConfig/AdvancedTab'
import { ListingPicker } from './providerConfig/ChoicePickers'
import { useProviderConfigDraft } from './providerConfig/useProviderConfigDraft'
import Button from './ui/Button'

const noProbe=()=>{}

/** The shared settings editor owns only this pending selection. It never
 * changes account settings or historical producing inputs. */
export function DurableInputs({attempt,state,acknowledged,currentSchema,onSaved,onEdited}:{
  attempt:ExtractionAttempt;state:DurableRead;acknowledged:number;currentSchema:string|null;onSaved:()=>void;onEdited:()=>Promise<void>;
}) {
  const editor=useProviderConfigDraft({accountId:'',providers:[],scheduleProbe:noProbe,cancelProbe:noProbe,disposeProbe:noProbe})
  // One edit session per editing acknowledgement (`acknowledged` opened the editor): changes stay local, no later read
  // overwrites the draft, and Save is fenced by the acknowledgement's version. Acknowledging keeps the inputs the draft
  // starts from, so a read from just before it serves as well as one after.
  const [baseline,setBaseline]=useState(()=>({controlVersion:acknowledged,read:state}))
  const initialized=useRef<typeof baseline|null>(null)
  const selection=baseline.read.pendingSelection??baseline.read.selection
  const used=selection.method
  const pinned=used.settings&&'unified' in used.settings?used.settings.unified.defaults:undefined
  const unified=pinned!==undefined
  const [schemaId,setSchemaId]=useState<string>(selection.schemaRevisionId)
  const [listing,setListing]=useState<ExtractionModelListing|null>(null)
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
  useEffect(()=> {
    if(initialized.current===baseline)return
    initialized.current=baseline
    const config:ModelConfig={connections:[],routes:{interaction:null,schemaSuggestion:null},ingestionModels:{},
      extractionModels:used.models??{},extractionSettings:canonicalExtractionSettings(attempt.strategy==='ARTICLE'
        ? used.settings.article?{article:used.settings.article}:{}
        : {catalog:used.settings})}
    editor.initialize(config)
    setSchemaId(selection.schemaRevisionId)
  },[baseline,selection.schemaRevisionId,used.models,used.settings,attempt.strategy,editor])
  useEffect(()=> {
    const controller=new AbortController()
    void readExtractionModels(controller.signal).then(next=>{if(!controller.signal.aborted)setListing(next)})
      .catch(()=>{}) // Deployment defaults and the captured model keys remain visible.
    return()=>controller.abort()
  },[])
  // Every command moves the control version: a read past the baseline means these inputs were adopted, discarded or
  // replaced elsewhere, or that Save would conflict with another command.
  const stale=state.controlVersion>baseline.controlVersion
  const reload=async()=> {
    setBusy(true);setError(null)
    try {
      // Gone pending inputs are acknowledged again, which holds the Extraction paused while the draft is edited.
      if(state.pendingSelection)setBaseline({controlVersion:state.controlVersion,read:state})
      else {setBaseline(await beginDurableInputEdit(attempt.extractionId));await onEdited()}
    } catch(error){setError(error instanceof Error?error.message:'Unable to reload the draft.')}
    finally{setBusy(false)}
  }
  const save=async()=> {
    if(!editor.draft)return
    setBusy(true);setError(null)
    try {
      const edited=activeMethod(editor.draft.extractionModels,editor.draft.extractionSettings,attempt.strategy,baseline.read.selection.resolved.catalogRecipe,unified)
      // The editor holds account-shaped settings, which carry no defaults version: keep the one this Extraction runs under.
      const method=pinned!==undefined&&'unified' in edited.settings
        ?{...edited,settings:{unified:{...edited.settings.unified,defaults:pinned}}}:edited
      await durableRequest(`${durableRoot(attempt.extractionId)}/selection`,{expectedVersion:baseline.controlVersion,schemaRevisionId:schemaId,method})
      onSaved()
    } catch(error){setError(error instanceof Error?error.message:'Unable to save pending inputs.')}
    finally{setBusy(false)}
  }
  return <section aria-label="Revised inputs" className="space-y-3 border-t border-line pt-3">
    <p className="text-secondary">Changes apply after in-flight work is saved. Earlier values keep their producing schema and settings. Editing cancels an earlier pending Resume.</p>
    <fieldset disabled={busy} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <label className="block text-secondary">Schema to use next<select className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1 text-secondary" value={schemaId} onChange={event=>setSchemaId(event.target.value)}>
        <option value={selection.schemaRevisionId}>Keep selected schema</option>
        {currentSchema&&currentSchema!==selection.schemaRevisionId&&<option value={currentSchema}>Current saved schema</option>}
      </select></label>
      {editor.draft&&editor.saved&&<>
        {(['fields','reasoning'] as const).map(role=><label key={role} className="block text-secondary">{role==='fields'?'Field values model':'Reasoning model'}
          <ListingPicker ariaLabel={role==='fields'?'Field values model':'Reasoning model'} group="Models this deployment runs" value={editor.draft!.extractionModels[role]??''}
            defaultKey={listing?.defaults[role]} choices={listing?.models.filter(model=>model.roles.includes(role)).map(model=>({key:model.key,name:model.repo,serving:model.serving}))??null}
            unserved="Not serving" onChange={(key:string)=>editor.setExtractionModel(role,key)}/>
        </label>)}
        <AdvancedTab draft={editor.draft} saved={editor.saved} editor={editor} focusIssue={false} onIssueFocused={noProbe} unifiedCatalog={unified} unifiedDefaults={pinned}
          extractionStrategy={attempt.strategy==='ARTICLE'?'article':'catalog'}/>
      </>}
      {editor.settingsIssues.map(issue=><p key={issue.path} role="alert" className="text-secondary text-danger">{issue.message}</p>)}
      {stale&&<p role="status" className="text-secondary">The Extraction changed after this draft started.{' '}
        <Button onClick={()=>void reload()}>Reload draft</Button></p>}
      <Button variant="positive" disabled={stale||!editor.draft||editor.settingsIssues.length>0} onClick={()=>void save()}>Save pending inputs</Button>
    </fieldset>
    {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
  </section>
}
