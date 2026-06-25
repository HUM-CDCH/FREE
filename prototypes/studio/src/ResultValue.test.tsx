import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ResultValue from './ResultValue'

describe('ResultValue', () => {
  it('marks null and empty values as missing', () => {
    const html = renderToStaticMarkup(<ResultValue name="Root" value={{ title: '', date: null }} />)

    expect(html).toContain('Missing')
    expect(html.match(/Missing/g)?.length).toBe(2)
  })

  it('renders arrays as expandable item lists', () => {
    const html = renderToStaticMarkup(<ResultValue name="People" value={[{ name: 'Anna' }]} />)

    expect(html).toContain('1 item')
    expect(html).toContain('Item 1')
    expect(html).toContain('Anna')
  })
})
