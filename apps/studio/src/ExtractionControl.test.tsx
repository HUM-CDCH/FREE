// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {ExtractionControl} from './ExtractionControl'
import {useDurableReading} from './durableReader'

vi.mock('./durableReader',()=>({useDurableReading:vi.fn()}))
afterEach(()=>{cleanup();vi.resetAllMocks()})
const revisions=[{schemaRevisionId:'old',revisionNumber:9,recordScope:'records'},
  {schemaRevisionId:'pending',revisionNumber:14,recordScope:'records'}]
it('waits for pending inputs to be applied or discarded before Resume',()=>{
  const state={selection:{schemaRevisionId:'old'},pendingSelection:{schemaRevisionId:'pending'},schemaRevisions:revisions}
  vi.mocked(useDurableReading).mockReturnValue({state} as never)
  const onCommand=vi.fn(),props={reader:null,control:{label:'Resume',action:'resume' as const},busy:false,onCommand}
  const view=render(<ExtractionControl {...props}/>)
  const button=screen.getByRole('button',{name:'Resume'})
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-description','Apply or discard the pending inputs (schema revision 14 (Catalog)) before continuing.')
  fireEvent.click(button)
  expect(onCommand).not.toHaveBeenCalled()
  vi.mocked(useDurableReading).mockReturnValue({state:{...state,pendingSelection:null}} as never)
  view.rerender(<ExtractionControl {...props}/>)
  expect(button).toBeEnabled()
  expect(button).toHaveAttribute('title',expect.stringContaining('schema revision 9 (Catalog)'))
  fireEvent.click(button)
  expect(onCommand).toHaveBeenCalledExactlyOnceWith('resume')
})
it('describes Pause but gives a draining disabled control no Continue hint',()=>{
  vi.mocked(useDurableReading).mockReturnValue(null)
  const props={reader:null,busy:false,onCommand:vi.fn()}
  const view=render(<ExtractionControl {...props} control={{label:'Pause',action:'pause'}}/>)
  expect(screen.getByRole('button',{name:'Pause'})).toHaveAttribute('title','Pause after the calls in flight; their work is saved')
  view.rerender(<ExtractionControl {...props} control={{label:'Pausing…',action:null}}/>)
  const button=screen.getByRole('button',{name:'Pausing…'})
  expect(button).toBeDisabled()
  expect(button).not.toHaveAttribute('title')
  expect(button).not.toHaveAttribute('aria-description')
})
