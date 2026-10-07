# CodeGraph prompt hook

`settings.json` runs `scripts/codegraph-prompt-hook.mjs` before delegating to
`codegraph prompt-hook`. It skips background/system notification envelopes,
subagent and cross-session messages, slash commands and their command
envelopes. Invalid input, unavailable CodeGraph tooling and runs over 10 s
(killed with SIGKILL) exit quietly without blocking the prompt.

The hook uses the input JSON's `cwd`, which can differ from
`CLAUDE_PROJECT_DIR` after entering a worktree
([Claude Code hook reference](https://code.claude.com/docs/en/hooks#reference-scripts-by-path)).
An index must exist at
`.codegraph/codegraph.db` (or `$CODEGRAPH_DIR/codegraph.db` when that names a
plain directory, as CodeGraph resolves it) in that directory or one of its ancestors within
the same Git working tree. Lookup stops at `.git` (a directory in a regular
checkout, a file in a linked worktree), so an unindexed nested worktree stays
quiet instead of borrowing the main checkout's index.

To enable context in a worktree, run `codegraph init -i` from its root. Indexing
is an explicit choice; the hook never initializes an index.

Run the hook regression checks with:

```bash
node --test scripts/codegraph-prompt-hook.test.mjs
```

They also run as part of `pnpm test:unit:node` and `pnpm test`.
