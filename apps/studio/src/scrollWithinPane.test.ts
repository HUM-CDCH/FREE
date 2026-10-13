// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { scrollWithinPane } from './scrollWithinPane'

afterEach(()=>vi.unstubAllGlobals())

function pane(top: number, height=100) {
  const container=document.createElement('div'),element=document.createElement('div')
  container.getBoundingClientRect=()=>new DOMRect(0,0,400,600)
  element.getBoundingClientRect=()=>new DOMRect(0,top,400,height)
  container.scrollTo=vi.fn()
  return {container,element}
}

it('keeps a fully visible linked item in place',()=>{
  const {container,element}=pane(100)
  scrollWithinPane(container,element)
  expect(container.scrollTo).not.toHaveBeenCalled()
})

it.each([[650,'smooth'],[2000,'auto']] as const)('reveals an item at %i in its own pane with %s scrolling',(top,behavior)=>{
  const {container,element}=pane(top)
  container.scrollTop=50
  scrollWithinPane(container,element)
  expect(container.scrollTo).toHaveBeenCalledExactlyOnceWith({top:50+top-250,left:0,behavior})
})

it('aligns a result taller than its pane at the top so its field and controls are visible',()=>{
  const {container,element}=pane(900,800)
  scrollWithinPane(container,element)
  expect(container.scrollTo).toHaveBeenCalledWith({top:892,left:0,behavior:'auto'})
})

it('respects reduced motion for short hops',()=>{
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})))
  const {container,element}=pane(650)
  scrollWithinPane(container,element)
  expect(container.scrollTo).toHaveBeenCalledWith({top:400,left:0,behavior:'auto'})
})
