import { useEffect, useRef, useState } from 'react'
import { recordScopeSchema, schemaDefinitionSchema, type RecordScope } from 'extraction/schema'
import {
  appendSchemaRevision,
  getSchemaRevision,
  initializeSchemaRevision,
  listSchemaRevisions,
  listExtractionSchemas,
} from './schemaRevisions'
import type { AcknowledgedSchemaRevision } from './schemaSaveCoordinator'
import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract'
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
   * controller's first successful generate() initializes it. A reopened
   * revision carries the source declaration it was saved with.
   */
  extractionSchema:
    | (AcknowledgedSchemaRevision & { sourceCoverage?: SourceCoverage | null })
    | null
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
  // A recovered Article/Catalog choice, applied once mounted: choosing a scope starts a save, never during render.
  const recoveredRecordScope = useRef<RecordScope | null>(null)
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
      if (!parsed.success) return null
      // Captures before the scope was recorded carry none: they keep the acknowledged revision's.
      const recordScope = recordScopeSchema.safeParse(candidate.recordScope)
      return { draft: parsed.data, recordScope: recordScope.success ? recordScope.data : null }
    }
    const recovered =
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
      append: (extractionSchemaId, expectedRevisionNumber, definition, sourceCoverage, recordScope) =>
        appendSchemaRevision(
          scope.projectContextId,
          extractionSchemaId,
          expectedRevisionNumber,
          definition,
          sourceCoverage,
          undefined,
          recordScope,
        ),
      initialize: (definition, signal, sourceCoverage, recordScope) =>
        initializeSchemaRevision(scope.projectContextId, definition, sourceCoverage, signal, recordScope),
      reconcileInitialization: async () => {
        const latest = (await listExtractionSchemas(scope.projectContextId, 1))[0]
        return latest?.currentRevision ? getSchemaRevision(scope.projectContextId, latest.extractionSchemaId, latest.currentRevision.schemaRevisionId) : null
      },
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
      initialSourceCoverage: initial?.sourceCoverage ?? null,
      onCommitMessage: scope.onCommitMessage,
    })
    if (recovered) {
      created.replaceDraft(recovered.draft, 'Recovered unsaved draft')
      recoveredRecordScope.current = recovered.recordScope
    }
    return created
  })

  // An unsaved Article/Catalog choice comes back with its draft. A scope change saves at once and carries the
  // recovered draft, so both land in one revision.
  useEffect(() => {
    const recordScope = recoveredRecordScope.current
    recoveredRecordScope.current = null
    if (recordScope !== null) controller.setRecordScope(recordScope)
  }, [controller])

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
          recordScope: save.recordScope,
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
