import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

const hex = (token: string) => {
  const match = css.match(new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`, 'i'))
  if (!match) throw new Error(`Missing color token: ${token}`)
  return match[1]
}

const luminance = (color: string) => {
  const channels = color
    .slice(1)
    .match(/../g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

const contrast = (foreground: string, background: string) => {
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  )
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('Studio interface theme', () => {
  it.each([
    ['ink-muted', 'surface'],
    ['ink-muted', 'canvas'],
    ['ink-muted', 'surface-muted'],
    ['ink-faint', 'surface'],
    ['ink-faint', 'canvas'],
    ['ink-faint', 'surface-muted'],
    ['accent', 'surface'],
    ['accent', 'canvas'],
    ['accent', 'surface-muted'],
  ])('%s text passes AA on %s', (foreground, background) => {
    expect(contrast(hex(foreground), hex(background))).toBeGreaterThanOrEqual(4.5)
  })

  it('white text passes AA on the accent, positive and danger fills', () => {
    expect(contrast('#ffffff', hex('accent'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', hex('green'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', hex('danger'))).toBeGreaterThanOrEqual(4.5)
  })

  it('defines a dual-color focus indicator and opts entry motion in', () => {
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid[^}]*box-shadow:/s)
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)[\s\S]*\.animate-fadeup/,
    )
  })
})
