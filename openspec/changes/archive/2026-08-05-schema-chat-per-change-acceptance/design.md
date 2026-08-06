## Context

The first change established immutable, id-addressed schema proposal records and atomic whole-proposal review. This change adds one decision per record without changing the API response or allowing the displayed proposal to drift as decisions change.

## Goals / Non-Goals

**Goals:**
- Accept or reject each changed node independently, with all changes accepted initially.
- Derive every candidate materialisation from the original schema and the immutable change records.
- Keep proposal rows and their proposed values stable while decisions change.

**Non-Goals:**
- Aspect-level decisions within one node.
- New model calls, API fields, persistence, undo, or proposal editing.

## Decisions

1. `SchemaPanel` stores accepted change ids, not a mutable working tree. This gives one decision to a rename-plus-retype record and avoids duplicating proposal state.
2. `replaySchemaChanges(original, changes, acceptedIds)` rebuilds the candidate tree on each toggle and on Apply. Existing nodes are addressed by stable id; additions retain the parent id resolved during derivation, so replay never reinterprets model paths after a parent rename is rejected.
3. Replay changes only a node's own state and preserves its current descendants when both old and new forms are containers. This prevents an accepted parent change from smuggling rejected descendant changes through its complete `after` snapshot.
4. The immutable proposed tree remains the diff projection. Replay outcomes update counts and row status, but rejected rows do not morph back to original values.

## Risks / Trade-offs

- [An accepted child addition depends on a rejected added parent] -> Replay marks the child unresolved until its parent is accepted; Apply materialises only resolvable accepted changes.
- [An accepted ancestor removal makes descendant changes unreachable] -> Replay recomputes those outcomes by id and reports them unresolved.

## Migration Plan

No migration or compatibility path is needed. The pending proposal is local component state and is replaced on reload.

## Open Questions

None.
