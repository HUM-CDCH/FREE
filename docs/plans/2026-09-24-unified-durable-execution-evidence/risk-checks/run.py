"""Run isolated plan probes using an existing disposable PostgreSQL container."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import quote
from uuid import uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
container = sys.argv[1]  # caller selects an existing test container; never stop it
name = "free_test_plan_risks_" + uuid4().hex[:10]
names = [name, name + "_restore"]
password = subprocess.check_output(
    ["docker", "exec", container, "printenv", "POSTGRES_PASSWORD"], text=True
).strip()
env = os.environ.copy()
env.update(FREE_RISK_ROOT=str(ROOT), FREE_RISK_CONTAINER=container)
for key, database in zip(["DATABASE_URL", "FREE_RISK_RESTORE_URL"], names):
    env[key] = f"postgresql://postgres:{quote(password, safe='')}@127.0.0.1:5432/{database}"
created = []
output = []

def run(args, cwd=ROOT, retain=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=120)
    message = result.stdout + result.stderr
    # The container credential is used only for the local test connection.
    for secret in [password, quote(password, safe="")]:
        if secret:
            message = message.replace(secret, "<redacted>")
    if retain and message.strip():
        output.append(message.strip())
    if result.returncode:
        print(message)
        raise RuntimeError(f"Probe command failed: {args[0]} (exit {result.returncode})")
    return message

try:
    # The existing repository guard runs before creating or opening either DB.
    run([str(ROOT / "packages/db/node_modules/.bin/tsx"), "-e",
         "import {validateDisposableTestDatabaseTarget as check} from './packages/db/src/database-url.ts';"
         "check(process.env.DATABASE_URL!);check(process.env.FREE_RISK_RESTORE_URL!);"])
    for database in names:
        run(["docker", "exec", container, "createdb", "-U", "postgres", database])
        created.append(database)
    migration = json.loads(run([str(ROOT / "packages/db/node_modules/.bin/prisma-next"), "migrate", "--yes"], ROOT / "packages/db", retain=False))
    output.append(json.dumps({"migration": {key: migration[key] for key in ["ok", "migrationsApplied"]}}))
    output.append(json.dumps({"checkout": run(["git", "rev-parse", "HEAD"], retain=False).strip(),
                              "node": run(["node", "--version"], retain=False).strip(),
                              "postgres": run(["docker", "exec", container, "psql", "-U", "postgres", "-d", name, "-Atc", "show server_version"], retain=False).strip()}))
    with tempfile.TemporaryDirectory(prefix="free-plan-risks-") as scratch:
        env["FREE_RISK_SCRATCH"] = scratch
        for script in ["current-code.mts", "protocols.mts"]:
            print(run([str(ROOT / "packages/db/node_modules/.bin/tsx"), str(HERE / script)]), end="")
    print("All assertions passed.")
finally:
    for database in reversed(created):
        run(["docker", "exec", container, "dropdb", "-U", "postgres", "--force", database])
    (HERE / "results.txt").write_text("\n".join(output) + "\nDisposable databases removed.\n")
