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
  const row={id:'correction',extractionId:'producing-extraction',sourceDocumentId:'source',snapshotVersion:1,valueId:'value',revision:2,feedbackVersion:2,included:true,active:true,selectionId:'producing',
    targetCompatibility:'incompatible',candidate:{value:'Saved correction',grounded:false,sourceContext:'source'},decision:{action:'EDITED'}}
  request.mockResolvedValueOnce([row])
  const view=render(<ProjectFeedback projectId="project" target="extraction" revision="text-selection:1"/>)
  const details=view.container.querySelector('details')!
  details.open=true;fireEvent(details,new Event('toggle'))
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(1))
  view.rerender(<ProjectFeedback projectId="project" target="extraction" revision="numeric-selection:2"/>)
  await screen.findByText(/Doesn’t fit this schema/)
  expect(screen.getByRole('link',{name:'Open in document'})).toHaveAttribute('href',
    '/projects/project/documents/source?extractionId=producing-extraction&value=value&snapshotVersion=1&feedbackVersion=2')
  const warning=screen.getByRole('link',{name:'1 correction doesn’t fit'})
  expect(view.container.querySelector(warning.getAttribute('href')!.replaceAll(':','\\:'))).toHaveTextContent('Saved correction')
  await act(async()=>oldResolve([{...row,revision:1,targetCompatibility:'compatible'}]))
  expect(screen.getByText('In use · Doesn’t fit this schema')).toBeVisible()
  expect(screen.queryByText('In use')).not.toBeInTheDocument()
  expect(details.open).toBe(true)
})

it('reloads committed inclusion even when guidance is reopened during the save',async()=>{
  let commit:()=>void=()=>{}
  const row={id:'correction',extractionId:'producing-extraction',sourceDocumentId:'source',snapshotVersion:1,valueId:'value',revision:2,feedbackVersion:2,included:true,active:true,selectionId:'producing',
    targetCompatibility:'not_evaluated',candidate:{value:'Saved correction',grounded:false,sourceContext:'source'},decision:{action:'EDITED'}}
  const request=vi.mocked(durableRequest)
  request.mockResolvedValueOnce([row])
  request.mockImplementationOnce(()=>new Promise(resolve=>{commit=()=>resolve({})}))
  request.mockResolvedValueOnce([row])
  request.mockResolvedValueOnce([{...row,revision:3,feedbackVersion:3,included:false}])
  const view=render(<ProjectFeedback projectId="project"/>)
  const details=view.container.querySelector('details')!
  details.open=true;fireEvent(details,new Event('toggle'))
  fireEvent.click(await screen.findByRole('button',{name:'Stop using'}))
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(2))
  details.open=false;fireEvent(details,new Event('toggle'))
  await act(async()=>{})
  details.open=true;fireEvent(details,new Event('toggle'))
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(3))
  await act(async()=>commit())
  await screen.findByRole('button',{name:'Use'})
  expect(screen.getByText('Not used')).toBeVisible()
  expect(request).toHaveBeenCalledTimes(4)
})
