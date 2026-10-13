import type { EvidenceLink } from '../shared/groundedExtraction'
import type { RailMarkState } from './useEvidenceOverlays'

/** A value the workspace asks Results to select, for one Extraction: a value link's (`navigate`, which shows its
 *  Evidence) or a mark's. `seq` names the request; Results acts on it once. */
export type SelectionRequest = { key: string; navigate: boolean; seq: number; extractionId: string }
/** The shown Results' values for the document's marks, with the Extraction they belong to. */
export type PublishedMarks = RailMarkState & { extractionId: string }
export type SelectionSnapshot = { request: SelectionRequest | null; marks: PublishedMarks | null; dim: EvidenceLink | null }
export type SelectionChannel = ReturnType<typeof createSelectionChannel>

/**
 * The workspace's channel between the document pane and Results: requests to select a value go to Results; Results
 * publishes its marks and one-by-one's dimming back. A snapshot keeps its identity until something changes. It holds
 * nothing to dispose.
 */
export function createSelectionChannel() {
  let snapshot: SelectionSnapshot = { request: null, marks: null, dim: null }
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
    select(key: string, navigate: boolean, extractionId: string) {
      seq += 1
      set({ request: { key, navigate, seq, extractionId } })
      return seq
    },
    /** Clears the request only while it is still `requestSeq`'s. */
    consume(requestSeq: number) {
      if (snapshot.request?.seq === requestSeq) set({ request: null })
    },
    publish(next: Partial<Pick<SelectionSnapshot, 'marks' | 'dim'>>) {
      set(next)
    },
  }
}
