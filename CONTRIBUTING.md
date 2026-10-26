# Contributing

## Workflow

- Work on a branch from `dev`, open a pull request against `dev`, get one
  review, then merge. GitHub CI runs only for `main`: merge PRs from `dev`,
  pushes to `main` and `main`'s merge queue run the full
  [`verify`](.github/workflows/verify.yml) workflow. `dev` has no automatic
  CI, so before asking for review run `pnpm typecheck`, `pnpm lint` and
  `pnpm test:unit` locally, plus the
  [tiers](docs/operations/local-development.md#verification) your change
  touches.
- Reviewers, human or agent, also check the diff against
  [CODING_STANDARDS.md](CODING_STANDARDS.md).
- Give each PR one coherent, testable review boundary: the smallest change that
  is still complete end to end, whatever its size. A larger PR is fine when
  splitting it would leave a non-working layer, or when most of it is
  mechanical, generated, or review evidence.
- Use GitHub Issues for work that needs triage, planning, or coordination. A
  self-contained change may originate in its PR. Link the originating Issue
  when one exists; a stacked PR instead identifies its base, adjacent PRs, and
  merge order.

## Worktree lifecycle

Use one worktree per active task and reuse it for follow-up work. Read-only
investigation does not need a worktree. Do not copy a checkout with `cp` or
`rsync`: ignored environments, artifacts, and nested worktrees can be copied
too, while copied `.git` pointers still refer to the original worktree.

From either the main checkout or an existing linked worktree, create a new
task checkout beside the main repository, not inside the current checkout:

```bash
name=short-task-name
branch=fix/short-task-name
common=$(git rev-parse --path-format=absolute --git-common-dir)
repo=$(dirname "$common")
worktrees="$(dirname "$repo")/$(basename "$repo").worktrees"
worktree="$worktrees/$name"
git -C "$repo" worktree add "$worktree" -b "$branch" origin/dev
```

Use a single directory name for `name`, without slashes or `..`. If already
assigned a worktree, use it instead of running this command again.

Install only what the task needs:

- Documentation/review: no dependency installation.
- Node-only work: `FREE_SKIP_PYTHON=1 pnpm install --frozen-lockfile`.
  The default install also creates the Parsing Service's Python environment,
  including its ML dependencies, in each checkout.
- Python work: use `pnpm install --frozen-lockfile`, or run
  `uv sync --frozen` from `apps/parsing_service` when Node is not needed.
  Do not share a mutable virtualenv between concurrent worktrees: editable
  installs and dependency changes can make one task execute another's code.

Before retiring a completed task, set `worktree` to its absolute path if using
a new shell, stop its processes, and check tracked, untracked, and ignored files:

```bash
git -C "$worktree" status --short --untracked-files=all
git -C "$worktree" ls-files --others --ignored --exclude-standard --directory
```

Preserve uncommitted changes, detached commits, credentials, local data, and
required evidence before removal. A merged PR alone does not prove a checkout
is disposable. Once the task's commits are retained and no needed files remain,
run `git worktree remove "$worktree"` from another checkout, without `--force`.
`git worktree prune` only removes stale administrative records; it does not
remove existing checkout directories. Report any retained checkout and its
reason rather than silently abandoning it.

For an inactive checkout that must retain source or evidence, remove only
verified untracked, reproducible dependency/cache directories when storage is
tight. Never use blanket `git clean -fdx`, delete database/model volumes, or
archive entire environments as part of routine task cleanup.

On Btrfs, reflinked environments may share data while still multiplying inode
and extent-reference metadata. Directory sizes are not reliable reclaim
estimates; assess both `btrfs filesystem usage` and extent sharing before
promising recovered space.

## Labels

Use topic labels to make it clear which part of the system an issue touches:
`frontend`, `backend`, `evaluation`, `examples`, `docs`.

## Docs

Keep domain language in [CONTEXT.md](CONTEXT.md), durable decisions in
`docs/adr/`, and current contracts beside the product area they describe.
Track unresolved work and open questions in GitHub Issues and pull requests.
Execution plans, run logs, review logs, and validation evidence go in the pull
request or Issue, not in `docs/`.

This repository is public. Never commit credentials, internal hostnames or IP
addresses, personal data, or documents you may not redistribute; test fixtures
use synthetic documents only.
