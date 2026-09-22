"""`kei-jobs`: put the schema in place, and run the slot's worker.

Two commands and no third: everything else a deployment needs (the API, the converter) has its own entry point,
and a worker that also migrated would make a restart a migration.
"""
from __future__ import annotations

import argparse
import sys

from kei_exp.jobs import schema, store
from kei_exp.jobs.app import DATABASE_URL, SLOT


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="kei-jobs", description="The kei-exp job backend")
    parser.add_argument("--database-url", default=DATABASE_URL, help="PostgreSQL connection string")
    commands = parser.add_subparsers(dest="command", required=True)

    migrate = commands.add_parser("schema", help="Show or apply the database schema")
    migrate.add_argument("--apply", action="store_true", help="Create the schema; without it, only report")

    serve = commands.add_parser("worker", help="Run this slot's worker in the foreground")
    serve.add_argument("--slot", default=SLOT, help="Deployment slot; it names the queue and the ownership lock")

    args = parser.parse_args(argv)
    if args.command == "schema":
        if args.apply:
            print(f"schema version {schema.apply(args.database_url)} applied to {store.redact(args.database_url)}")
            return
        found = schema.version(args.database_url)
        print(f"schema version {found} (this build wants {schema.SCHEMA_VERSION})")
        if found != schema.SCHEMA_VERSION:
            sys.exit(1)
        return
    from kei_exp.jobs.worker import serve as serve_slot  # imported late: `schema` must work before a worker can
    serve_slot(args.slot, args.database_url)


if __name__ == "__main__":
    main()
