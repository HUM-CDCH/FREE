import { useEffect, useRef, useState } from 'react'
import {
  appendSchemaRevision,
  getSchemaRevision,
  initializeSchemaRevision,
  listSchemaRevisions,
} from './schemaRevisions'
import type { AcknowledgedSchemaRevision } from './schemaSaveCoordinator'
import {
  createSchemaEditorController,
  durableSchemaPersistence,
  type SchemaEditorController,
} from './currentSchemaRevision'

/**
 * Mount-scoped controller: created once, disposed on unmount. Consumers that
 * need a fresh lifecycle per selection key the component carrying this hook.
 */
export function useSchemaEditorController(
  factory: () => SchemaEditorController,
): SchemaEditorController {
  const [controller] = useState(factory)
  const pendingDisposal = useRef<{ cancelled: boolean } | null>(null)
  useEffect(() => {
    const scheduled = pendingDisposal.current
    if (scheduled) scheduled.cancelled = true
    return () => {
      const pending = { cancelled: false }
      pendingDisposal.current = pending
      // StrictMode replays setup after cleanup while retaining hook state.
      // Defer disposal one microtask so that replay can claim the controller;
      // a real unmount has no later setup and therefore disposes it.
      queueMicrotask(() => {
        if (!pending.cancelled) controller.dispose()
      })
    }
  }, [controller])
  return controller
}

export type DurableSchemaScope = {
  projectContextId: string
  /**
   * The open Extraction Schema, or null before the first generation — the
   * controller's first successful generate() initializes it.
   */
  extractionSchema: AcknowledgedSchemaRevision | null
  /** Save debounce; the Batch prepare screen passes 0, the workspace 1500. */
  debounceMs?: number
  /**
   * Present in document workspaces so chat-driven edits resolve a full model
   * context (including the source representation). Omitted scopes resolve a
   * schema-only context.
   */
  sourceRepresentationId?: string
  onCommitMessage?: (message: string) => void
}

export function useDurableCurrentSchemaRevision(
  scope: DurableSchemaScope,
): SchemaEditorController {
  const sourceRepresentationIdRef = useRef(scope.sourceRepresentationId)
  useEffect(() => {
    sourceRepresentationIdRef.current = scope.sourceRepresentationId
  }, [scope.sourceRepresentationId])
  const controller = useSchemaEditorController(() => {
    const initial = scope.extractionSchema
    const persistence = durableSchemaPersistence({
      initial,
      debounceMs: scope.debounceMs,
      append: (extractionSchemaId, expectedRevisionNumber, definition) =>
        appendSchemaRevision(
          scope.projectContextId,
          extractionSchemaId,
          expectedRevisionNumber,
          definition,
        ),
      initialize: (definition, signal) =>
        initializeSchemaRevision(scope.projectContextId, definition, signal),
      listRevisions: (extractionSchemaId, limit, signal) =>
        listSchemaRevisions(scope.projectContextId, extractionSchemaId, limit, signal),
      getRevision: (extractionSchemaId, schemaRevisionId, signal) =>
        getSchemaRevision(scope.projectContextId, extractionSchemaId, schemaRevisionId, signal),
    })
    persistence.modelContext = (revision) =>
      sourceRepresentationIdRef.current
        ? {
            projectContextId: scope.projectContextId,
            sourceRepresentationRevisionId:
              sourceRepresentationIdRef.current,
            extractionSchemaId: revision.extractionSchemaId,
            schemaRevisionId: revision.schemaRevisionId,
          }
        : {
            projectContextId: scope.projectContextId,
            extractionSchemaId: revision.extractionSchemaId,
            schemaRevisionId: revision.schemaRevisionId,
          }
    return createSchemaEditorController(persistence, {
      initialDraft: initial
        ? {
            recordDescription: initial.recordDescription,
            schemaNodes: initial.schemaNodes,
          }
        : null,
      initialRevisionNumber: initial?.revisionNumber,
      initialExtractableRevisionId: initial?.schemaRevisionId ?? null,
      onCommitMessage: scope.onCommitMessage,
    })
  })

  // Warn before leaving with an unsaved durable draft. The Batch prepare
  // screen gains this guard through unification; the workspace always had it.
  useEffect(() => {
    let detach: (() => void) | null = null
    const sync = () => {
      const save = controller.snapshot().save
      const shouldWarn = save !== null && save.status !== 'saved'
      if (shouldWarn && detach === null) {
        const warn = (event: BeforeUnloadEvent) => event.preventDefault()
        window.addEventListener('beforeunload', warn)
        detach = () => window.removeEventListener('beforeunload', warn)
      } else if (!shouldWarn && detach !== null) {
        detach()
        detach = null
      }
    }
    sync()
    const unsubscribe = controller.subscribe(sync)
    return () => {
      unsubscribe()
      detach?.()
    }
  }, [controller])

  return controller
}
