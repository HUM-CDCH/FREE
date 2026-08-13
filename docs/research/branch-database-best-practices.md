# Local database isolation across Git branches

## Question

Is keeping a separate local PostgreSQL database for each Git branch or worktree a normal practice, and is it the right fix for FREE's branch-switching failures?

## Conclusion

Yes. There is no Git or PostgreSQL rule that mandates one database per branch, but it is a normal and well-supported way to isolate *disposable developer state* when branches carry incompatible schema, migration, or seeded-data histories. Docker Compose explicitly names multiple copies of an environment for feature branches as a development-host use case, and PostgreSQL databases are the server's top-level SQL-object boundary. [1][2][3]

For FREE, the project chose the more conventional workflow: keep one disposable local development database, verify its contract before startup, and require an explicit reset and reseed after an incompatible branch switch. Per-branch isolation remains a valid alternative if parallel environments become a concrete need.

The scope must include the *branch* to protect branch switching in one checkout. If the repository routinely uses parallel linked worktrees, adding the worktree identity prevents forced duplicate checkouts or detached worktrees from sharing a database. Git exposes both branch and per-worktree metadata. [1]

## What each mechanism is for

| Mechanism | Best use | Not a substitute for |
| --- | --- | --- |
| Database per branch/worktree | Persistent local state that must not cross incompatible histories | Checked-in schema/migrations |
| Migration history | The source of truth for evolving a database contract | Isolation from unrelated branch-local data |
| Disposable test database/container | Repeatable tests with a known-clean state | A developer's persistent local project state |
| Worktree-specific config/environment | Separating URLs, ports, caches, and other process-local settings | Applying migrations or preserving data |
| Schema-per-worktree | A lighter namespace boundary when an application can correctly own its schema/search path | Strong database-level isolation |

PostgreSQL describes schemas as a way to let many users use one database without interference, but cross-schema access is possible subject to privileges. A separate database is the clearer boundary for FREE because the migration and project-store contract own the whole database. [4]

## Safe operational rules

1. Version and apply the schema/migration history; do not treat a copied database as the source of truth. Rails describes migrations as the mechanism for evolving schema over time, while Prisma's development workflow detects migration-history conflicts and schema drift. [5][6]
2. Automatic *creation and initialization* is appropriate only for the known local default. PostgreSQL requires `CREATEDB` or superuser privilege to create a database, so this should remain a local-development convenience—not a production startup behavior. [2]
3. Never automatically reset or drop an existing database on startup. PostgreSQL's `DROP DATABASE` removes its objects and is constrained by live connections; development migration tools present reset as a deliberate destructive operation. [7][6]
4. Do not rewrite an explicit URL. It may point at a shared, retained, remote, or deliberately named database whose lifecycle is outside this convenience.
5. Keep test isolation separate. Testcontainers documents disposable real databases as useful because they start from a known state without cross-run or developer-machine contamination; that is valuable for tests, but unnecessary as the default for interactive development. [8]

## Decision for FREE

Use checked-in schema/migrations as the source of truth, verify the shared disposable development database before starting Studio, and stop with an actionable error on drift. Repair an incompatible branch switch with an explicit local-only reset followed by the existing seed command. Do not reset automatically during startup.

If parallel branch environments become common, revisit database-per-branch isolation using a branch plus worktree identity. Docker Compose supports that model through distinct project names, including per-feature-branch environments. [3]

## Sources

1. [Git: `git worktree`](https://git-scm.com/docs/git-worktree.html) — linked worktrees support simultaneous branch checkouts and have per-worktree metadata/configuration.
2. [PostgreSQL: Creating a database](https://www.postgresql.org/docs/current/manage-ag-createdb.html) — database creation, ownership, privileges, and templates.
3. [Docker Compose: Specify a project name](https://docs.docker.com/compose/how-tos/project-name/) — project names isolate environments; multiple copies for feature branches are a stated development-host use case.
4. [PostgreSQL: Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) — schemas as namespaces and their access model.
5. [Rails Guides: Active Record Migrations](https://guides.rubyonrails.org/active_record_migrations.html) — migrations evolve schema; reset versus replaying migrations.
6. [Prisma: Development and production workflow](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production) — development migrations, drift detection, and reset behavior.
7. [PostgreSQL: `DROP DATABASE`](https://www.postgresql.org/docs/current/sql-dropdatabase.html) — destructive behavior and connection constraints.
8. [Testcontainers: Database containers](https://java.testcontainers.org/modules/databases/) — real database containers start from a known state and avoid contamination in tests.
