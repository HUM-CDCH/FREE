// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import ReviewedValueEditor from './ReviewedValueEditor'
import type {SchemaNode} from 'extraction/schema'

afterEach(cleanup)

it.each(['string','verbatim-string','date'] as const)('keeps an empty %s correction in the editor',type=>{
  const save=vi.fn()
  render(<ReviewedValueEditor node={{id:'field',name:'field',type} as SchemaNode} initial={type==='date'?'2026-10-04':'Saved value'}
    saveLabel="Save edit" onSave={vi.fn()} onTypedSave={save} onCancel={vi.fn()}/>)
  fireEvent.change(screen.getByLabelText('Reviewed value'),{target:{value:type==='date'?'':'  '}})
  fireEvent.click(screen.getByRole('button',{name:'Save edit'}))
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a value.')
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Reviewed value'),{target:{value:type==='date'?'2026-10-05':'Saved correction'}})
  fireEvent.click(screen.getByRole('button',{name:'Save edit'}))
  expect(save).toHaveBeenCalledWith(type==='date'?'2026-10-05':'Saved correction')
})

it('preserves scalar parser errors before producing-type validation',()=>{
  const save=vi.fn()
  render(<ReviewedValueEditor node={{id:'field',name:'field',type:'integer'} as SchemaNode} initial={1}
    saveLabel="Save edit" onSave={vi.fn()} onTypedSave={save} onCancel={vi.fn()}/>)
  fireEvent.change(screen.getByLabelText('Reviewed value'),{target:{value:'1.5'}})
  fireEvent.click(screen.getByRole('button',{name:'Save edit'}))
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number.')
  expect(save).not.toHaveBeenCalled()
})
