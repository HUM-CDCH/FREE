// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,expect,it} from 'vitest'
import type {DurablePage,DurableRead,ResultSchemaRevision} from 'extraction/durable-types'
import {ResultSchemaNotice} from './ResultSchemaNotice'
import type {CurrentResultSchema} from './resultSchema'

afterEach(cleanup)
const old:ResultSchemaRevision={schemaRevisionId:'old',extractionSchemaId:'family',name:'Research',revisionNumber:9,recordScope:'records'}
const current:ResultSchemaRevision={...old,schemaRevisionId:'current',revisionNumber:14}
function shown({ids=['old'],revisionId='old',status='COMPLETED',readOnly=false,controlled=true,
  revisions=[old,current],head='old',pending=false}: {
  ids?:string[];revisionId?:string;status?:DurableRead['status'];readOnly?:boolean;controlled?:boolean;
  revisions?:ResultSchemaRevision[];head?:string;pending?:boolean
}={}) {
  const page={snapshotVersion:1,schemaRevisionId:revisionId,schemaRevisions:revisions,values:ids.map(schemaRevisionId=>({schemaRevisionId}))} as DurablePage
  const state={status,strategy:'CATALOG',selection:{id:'selection',schemaRevisionId:head},schemaRevisions:revisions,
    pendingSelection:pending?{id:'pending',schemaRevisionId:'current'}:null} as DurableRead
  return <ResultSchemaNotice page={page} state={state} current={current} controlled={controlled} readOnly={readOnly}/>
}

it('leaves a matching producing revision to the status line',()=>{
  const {container}=render(shown({ids:['current'],head:'current'}))
  expect(container).toBeEmptyDOMElement()
})
it('keeps an empty historical snapshot tied to its own selection',()=>{
  render(shown({ids:[],head:'current'}))
  expect(screen.getByText('These results use schema revision 9 (Catalog).')).toBeVisible()
})
it('names all revisions in mixed values after adopting newer inputs',()=>{
  render(shown({ids:['old','current','old'],head:'current',status:'PAUSED'}))
  expect(screen.getByText('These results contain values from multiple schema revisions: schema revision 9 (Catalog), schema revision 14 (Catalog).')).toBeVisible()
  expect(screen.queryByText(/Resume continues/)).not.toBeInTheDocument()
})
it.each(['FAILED','PAUSED'] as const)('explains what %s continues and how inputs can change',status=>{
  render(shown({status}))
  expect(screen.getByText(new RegExp(`${status==='FAILED'?'Retry':'Resume'} continues this extraction with schema revision 9`))).toBeVisible()
  expect(screen.getByText(/Use Change inputs/)).toBeVisible()
})
it('keeps pending inputs separate from the values already produced',()=>{
  render(shown({pending:true,status:'PAUSED'}))
  expect(screen.getByText('These results use schema revision 9 (Catalog).')).toBeVisible()
  expect(screen.getByText('Pending inputs use schema revision 14 (Catalog).')).toBeVisible()
  expect(screen.getByText('Apply or discard the pending inputs before resuming.')).toBeVisible()
  expect(screen.queryByText(/Resume continues/)).not.toBeInTheDocument()
})
it.each([{readOnly:true},{controlled:false}])('provides no lifecycle instructions for a historical or uncontrolled view: %j',options=>{
  render(shown({...options,status:'FAILED'}))
  expect(screen.getByText('These results use schema revision 9 (Catalog).')).toBeVisible()
  expect(screen.queryByText(/Retry continues/)).not.toBeInTheDocument()
})
it('does not invent a producing revision when metadata is unavailable',()=>{
  render(shown({revisions:[current]}))
  expect(screen.getByText('The producing schema revision could not be read.')).toBeVisible()
  expect(screen.queryByText(/results use schema revision 14/)).not.toBeInTheDocument()
})
it('does not recommend adopting an unknown current scope',()=>{
  const page={schemaRevisionId:'old',schemaRevisions:[old],values:[{schemaRevisionId:'old'}]} as DurablePage
  const state={status:'PAUSED',strategy:'CATALOG',selection:{schemaRevisionId:'old'},schemaRevisions:[old],pendingSelection:null} as DurableRead
  render(<ResultSchemaNotice page={page} state={state} current={{schemaRevisionId:'unknown',revisionNumber:14,recordScope:null}} controlled readOnly={false}/>)
  expect(screen.getByText(/Choose Article or Catalog in Schema/)).toBeVisible()
  expect(screen.queryByText(/Use Change inputs/)).not.toBeInTheDocument()
})
it('updates the comparison only when the acknowledged current revision changes',()=>{
  const page={schemaRevisionId:'old',schemaRevisions:[old,current],values:[{schemaRevisionId:'old'}]} as DurablePage
  const state={status:'COMPLETED',selection:{schemaRevisionId:'old'}} as DurableRead
  const props={page,state,controlled:true,readOnly:false}
  const view=render(<ResultSchemaNotice {...props} current={old}/>)
  expect(screen.queryByText(/The current schema/)).not.toBeInTheDocument()
  view.rerender(<ResultSchemaNotice {...props} current={current satisfies CurrentResultSchema}/>)
  expect(screen.getByText('The current schema is revision 14 (Catalog).')).toBeVisible()
  expect(page.values[0].schemaRevisionId).toBe('old')
})
