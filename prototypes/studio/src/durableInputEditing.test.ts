import { afterEach, expect, it, vi } from 'vitest'
import { beginDurableInputEdit } from './durableInputEditing'
import { durableRequest } from './durableExtractionApi'

vi.mock('./durableExtractionApi',()=>({durableRequest:vi.fn(),durableRoot:(id:string)=>`/api/extractions/${id}/durable`}))
afterEach(()=>vi.resetAllMocks())

it('reads the current control version and waits for the editing acknowledgement before changing local inputs',async()=> {
  let acknowledge!:(value:unknown)=>void
  vi.mocked(durableRequest).mockResolvedValueOnce({controlVersion:9})
    .mockImplementationOnce(()=>new Promise(resolve=>{acknowledge=resolve}))
  const localChange=vi.fn()
  const edit=beginDurableInputEdit('same-extraction').then(localChange)
  await vi.waitFor(()=>expect(durableRequest).toHaveBeenCalledTimes(2))
  expect(durableRequest).toHaveBeenLastCalledWith('/api/extractions/same-extraction/durable/control',{
    id:expect.any(String),expectedVersion:9,action:'editing',
  })
  expect(localChange).not.toHaveBeenCalled()
  acknowledge({controlVersion:10,pendingResume:false})
  await edit
  expect(localChange).toHaveBeenCalledOnce()
})

it('leaves local inputs unchanged when a competing command conflicts',async()=> {
  vi.mocked(durableRequest).mockResolvedValueOnce({controlVersion:9}).mockRejectedValueOnce(new Error('Another view changed this Extraction.'))
  const localChange=vi.fn()
  await expect(beginDurableInputEdit('same-extraction').then(localChange)).rejects.toThrow('Another view changed')
  expect(localChange).not.toHaveBeenCalled()
})
