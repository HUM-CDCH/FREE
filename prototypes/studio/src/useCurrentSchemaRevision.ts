import { useEffect, useRef, useState } from 'react'
import { schemaDefinitionSchema } from 'extraction/schema'
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
import {
  consumeSessionRecovery,
  isAuthenticationRedirecting,
  registerSessionRecoveryCapture,
  removeSessionRecovery,
} from './auth/sessionRecovery'

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
  const recoveryResourceId = `${scope.projectContextId}/${
    scope.extractionSchema?.extractionSchemaId ?? 'new'
  }/${scope.sourceRepresentationId ?? 'schema-only'}`
  const sourceRepresentationIdRef = useRef(scope.sourceRepresentationId)
  useEffect(() => {
    sourceRepresentationIdRef.current = scope.sourceRepresentationId
  }, [scope.sourceRepresentationId])
  const controller = useSchemaEditorController(() => {
    const initial = scope.extractionSchema
    const validateRecoveredDraft = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const candidate = value as Record<string, unknown>
      if (
        candidate.extractionSchemaId !==
          (initial?.extractionSchemaId ?? null) ||
        candidate.acknowledgedRevisionNumber !==
          (initial?.revisionNumber ?? null)
      )
        return null
      const parsed = schemaDefinitionSchema.safeParse(candidate.draft)
      return parsed.success ? parsed.data : null
    }
    const recoveredDraft =
      consumeSessionRecovery(
        'schema-draft',
        recoveryResourceId,
        validateRecoveredDraft,
      ) ??
      (initial
        ? consumeSessionRecovery(
            'schema-draft',
            `${scope.projectContextId}/new/${
              scope.sourceRepresentationId ?? 'schema-only'
            }`,
            validateRecoveredDraft,
          )
        : null)
    const persistence = durableSchemaPersistence({
      projectContextId: scope.projectContextId,
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
    const created = createSchemaEditorController(persistence, {
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
    if (recoveredDraft)
      created.replaceDraft(recoveredDraft, 'Recovered unsaved draft')
    return created
  })

  useEffect(() => {
    const unregister = registerSessionRecoveryCapture(
      'schema-draft',
      recoveryResourceId,
      () => {
        const save = controller.snapshot().save
        if (!save || save.status === 'saved') return null
        return {
          extractionSchemaId: save.acknowledged.extractionSchemaId,
          acknowledgedRevisionNumber: save.acknowledged.revisionNumber,
          draft: save.draft,
        }
      },
    )
    const removeWhenSaved = () => {
      if (controller.snapshot().save?.status === 'saved')
        removeSessionRecovery('schema-draft', recoveryResourceId)
    }
    const unsubscribe = controller.subscribe(removeWhenSaved)
    removeWhenSaved()
    return () => {
      unsubscribe()
      unregister()
    }
  }, [controller, recoveryResourceId])

  // Warn before leaving with an unsaved durable draft. The Batch prepare
  // screen gains this guard through unification; the workspace always had it.
  useEffect(() => {
    let detach: (() => void) | null = null
    const sync = () => {
      const save = controller.snapshot().save
      const shouldWarn = save !== null && save.status !== 'saved'
      if (shouldWarn && detach === null) {
        const warn = (event: BeforeUnloadEvent) => {
          if (!isAuthenticationRedirecting()) event.preventDefault()
        }
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
