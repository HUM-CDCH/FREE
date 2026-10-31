import type { EvidenceLink } from '../shared/groundedExtraction'
import type { RailMarkState } from './useEvidenceOverlays'

/** A value the workspace asks Results to select, for one Extraction: a value link's (`navigate`, which shows its
 *  Evidence) or a mark's. `seq` names the request; Results acts on it once. */
export type SelectionRequest = { key: string; navigate: boolean; seq: number; extractionId: string; linkedKeys?: readonly string[] }
/** The shown Results' values for the document's marks, with the Extraction they belong to. */
export type PublishedMarks = RailMarkState & { extractionId: string }
/** `hover`: the values under the pointer, on a mark or a Results row; each side lights the other's. */
export type SelectionSnapshot = { request: SelectionRequest | null; marks: PublishedMarks | null; dim: EvidenceLink | null; hover: readonly string[] | null }
export type SelectionChannel = ReturnType<typeof createSelectionChannel>

/**
 * The workspace's channel between the document pane and Results: requests to select a value go to Results; Results
 * publishes its marks and one-by-one's dimming back; either side says what is under the pointer. A snapshot keeps its
 * identity until something changes. It holds nothing to dispose.
 */
export function createSelectionChannel() {
  let snapshot: SelectionSnapshot = { request: null, marks: null, dim: null, hover: null }
  let seq = 0
  const listeners = new Set<() => void>()
  function set(next: Partial<SelectionSnapshot>) {
    if ((Object.keys(next) as (keyof SelectionSnapshot)[]).every(key => next[key] === snapshot[key])) return
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: () => snapshot,
    /** Replaces any pending request; returns its `seq`. */
    select(key: string, navigate: boolean, extractionId: string, linkedKeys?: readonly string[]) {
      seq += 1
      set({ request: { key, navigate, seq, extractionId, ...(linkedKeys ? { linkedKeys } : {}) } })
      return seq
    },
    /** Clears the request only while it is still `requestSeq`'s. */
    consume(requestSeq: number) {
      if (snapshot.request?.seq === requestSeq) set({ request: null })
    },
    publish(next: Partial<Pick<SelectionSnapshot, 'marks' | 'dim'>>) {
      set(next)
    },
    /** Notifies only a change of values: the pointer crossing a row's children says the same thing again. */
    hover(keys: readonly string[] | null) {
      const next = keys?.length ? keys : null, current = snapshot.hover
      if (next?.length === current?.length && (next ?? []).every((key, index) => key === current![index])) return
      set({ hover: next })
    },
  }
}
