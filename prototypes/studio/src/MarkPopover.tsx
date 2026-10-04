import { useEffect, useRef } from 'react'
import type { MarkInfo } from './useEvidenceOverlays'

/** Several values share one passage (results review redesign §7.2): the mark opens this list to choose one; Escape
 *  closes it and focus returns to the mark. */
export default function MarkPopover({ keys, describe, mark, onChoose, onClose }: {
  keys: readonly string[]
  describe: ReadonlyMap<string, MarkInfo>
  mark: HTMLElement
  onChoose: (key: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    return () => { if (mark.isConnected) mark.focus() }
  }, [mark])
  const rect = mark.getBoundingClientRect()
  return (
    <div ref={ref} role="dialog" aria-label="Values in this passage" style={{ left: rect.left, top: rect.bottom + 4 }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
      className="fixed z-50 flex min-w-48 flex-col rounded-md border border-line bg-surface p-1 shadow-float">
      {keys.map((key) => {
        const info = describe.get(key)
        return info && (
          <button key={key} type="button" onClick={() => onChoose(key)}
            className="cursor-pointer rounded px-2.5 py-1.5 text-left text-secondary text-ink outline-none hover:bg-surface-muted focus-visible:bg-surface-muted">
            <span className="font-mono text-ink-faint">{info.name}</span> · {info.value}
          </button>
        )
      })}
    </div>
  )
}
