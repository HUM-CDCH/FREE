// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectFeedback } from './ProjectFeedback'
import { durableRequest } from './durableExtractionApi'

vi.mock('./durableExtractionApi',()=>({durableRequest:vi.fn()}))
afterEach(()=>{cleanup();vi.resetAllMocks()})

it('refreshes open guidance after selection/review changes and ignores older responses',async()=>{
  let oldResolve:(rows:unknown[])=>void=()=>{}
  const request=vi.mocked(durableRequest)
  request.mockImplementationOnce(()=>new Promise(resolve=>{oldResolve=resolve}))
  const row={id:'correction',valueId:'value',revision:2,feedbackVersion:2,included:true,active:true,selectionId:'producing',
    targetCompatibility:'incompatible',candidate:{value:'Saved correction',grounded:false,sourceContext:'source'},decision:{action:'EDITED'}}
  request.mockResolvedValueOnce([row])
  const view=render(<ProjectFeedback projectId="project" target="extraction" revision="text-selection:1"/>)
  const details=view.container.querySelector('details')!
  details.open=true;fireEvent(details,new Event('toggle'))
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
  view.rerender(<ProjectFeedback projectId="project" target="extraction" revision="numeric-selection:2"/>)
  await screen.findByText(/incompatible for this target/)
  await act(async()=>oldResolve([{...row,revision:1,targetCompatibility:'compatible'}]))
  expect(screen.getByText(/Revision 2 · active/)).toBeVisible()
  expect(screen.queryByText(/Revision 1 · active/)).not.toBeInTheDocument()
  expect(details.open).toBe(true)
})

it('reloads committed inclusion even when guidance is reopened during the save',async()=>{
  let commit:()=>void=()=>{}
  const row={id:'correction',valueId:'value',revision:2,feedbackVersion:2,included:true,active:true,selectionId:'producing',
    targetCompatibility:'not_evaluated',candidate:{value:'Saved correction',grounded:false,sourceContext:'source'},decision:{action:'EDITED'}}
  const request=vi.mocked(durableRequest)
  request.mockResolvedValueOnce([row])
  request.mockImplementationOnce(()=>new Promise(resolve=>{commit=()=>resolve({})}))
  request.mockResolvedValueOnce([row])
  request.mockResolvedValueOnce([{...row,revision:3,feedbackVersion:3,included:false}])
  const view=render(<ProjectFeedback projectId="project"/>)
  const details=view.container.querySelector('details')!
  details.open=true;fireEvent(details,new Event('toggle'))
  fireEvent.click(await screen.findByRole('button',{name:'Exclude from guidance'}))
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(2))
  details.open=false;fireEvent(details,new Event('toggle'))
  await act(async()=>{})
  details.open=true;fireEvent(details,new Event('toggle'))
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(3))
  await act(async()=>commit())
  await screen.findByRole('button',{name:'Include in guidance'})
  expect(screen.getByText(/Revision 3 · active · excluded/)).toBeVisible()
  expect(request).toHaveBeenCalledTimes(4)
})
