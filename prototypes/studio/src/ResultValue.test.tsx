// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResultValue from './ui/ResultValue'

afterEach(cleanup)

describe('ResultValue', () => {
  it.each([
    { kind: 'object', value: { title: 'Anna' } },
    { kind: 'array', value: [{ title: 'Anna' }] },
  ])('exposes $kind navigation as a focusable native button', ({ value }) => {
    const onNavigateTo = vi.fn()
    render(<ResultValue name="People" value={value} path={['records', '0', 'people']} defaultExpanded={false} onNavigateTo={onNavigateTo} />)

    const button = screen.getByRole('button', { name: /^People/ })
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).not.toHaveAttribute('aria-expanded')
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(onNavigateTo).toHaveBeenCalledExactlyOnceWith(['records', '0', 'people'])
  })

  it.each([
    { kind: 'object', value: { title: 'Anna' } },
    { kind: 'array', value: ['Anna'] },
  ])('keeps inline $kind disclosure accessible', ({ value }) => {
    render(<ResultValue name="People" value={value} defaultExpanded={false} />)

    const button = screen.getByRole('button', { name: /^People/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('Anna').length).toBeGreaterThan(0)
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks null and empty values as missing', () => {
    const html = renderToStaticMarkup(<ResultValue name="Root" value={{ title: '', date: null }} />)

    expect(html).toContain('Missing')
    expect(html.match(/Missing/g)?.length).toBe(2)
  })

  it('renders arrays as expandable item lists', () => {
    const html = renderToStaticMarkup(<ResultValue name="People" value={[{ name: 'Anna' }]} />)

    expect(html).toContain('1 item')
    expect(html).toContain('Person 1')
    expect(html).toContain('Anna')
  })
})
