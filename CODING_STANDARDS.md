# Coding standards

Review-time judgement rules: things a reviewer must weigh that no linter or test
can check. Mechanical rules belong in lint config and tests, not here.

## Acceptance evidence for a bug fix

Review whether the regression reaches the reported failure and whether the
acceptance check demonstrates the intended result. Error handling, retries and
progress messages alone do not establish that the original operation succeeds.
For exports, inspect the resulting file's format, fields and row count. For
performance or transfer failures, use a representative payload size. A small
fixture may lock down the mechanism; the original scenario still needs an
acceptance check, with any remaining limitations stated in the PR.

## Effect-reported callbacks in tests

When a component reports through a callback from a React effect (e.g.
`onProgressChange` called in `useEffect`) after asynchronous work (a fetch, a
poll, a timer), a test that counts or clears that callback's calls first awaits
the call it expects, before `mockClear()` or counting. A report produced inside
a completed `act()` boundary (a synchronous `render` or `fireEvent`) has already
run and can be counted directly.

Why: an update that lands while `findBy*`/`waitFor` waits renders outside
`act()`, and its effects run after the commit; seeing the rendered text is not
enough, so on a loaded runner the call can land after the test moved on.

```tsx
await screen.findByText('1 completed · 1 running');
await waitFor(() => expect(onProgressChange).toHaveBeenCalled());
onProgressChange.mockClear();
```

Under fake timers, advance them inside `act` (`await act(() => vi.advanceTimersByTimeAsync(ms))`)
instead of `waitFor`, which waits on the frozen clock.

Reference: 3dded2ee (PR #197) fixed `BatchExtractionsPanel.test.tsx` this way
after it flaked in CI.

## Read order in cleanup decisions

When code deletes or cancels on the strength of several reads made one after
another, read each gate before the set it gates: a parent's quiescence before
the references it could still publish, references before the work they admit,
a directory listing before its writers' statuses. Name the order in a comment
beside the reads.

Why: each read is a snapshot. Something created between two reads is missed
when its gate is read last, and the cleanup removes what that newcomer still
needs.

Reference: `collectKei` (`prototypes/studio/api/_garbage_workflow.ts`) reads
parents before references; `delete_runs`
(`prototypes/parsing_service/src/kei_exp/workflows/gc.py`) lists `.prepare-*`
before reading which conversions may still write.
