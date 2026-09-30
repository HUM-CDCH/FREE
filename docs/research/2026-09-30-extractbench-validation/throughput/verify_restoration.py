"""Read-only deployment verification; optional new snapshots with --output NEW_DIRECTORY."""
import argparse
import json
import shlex
import subprocess
import time
from pathlib import Path

import benchmark as bench

out = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
args = parser.parse_args()
if args.output is not None:
    args.output.mkdir(parents=True, exist_ok=False)
commands = []

def read_remote(argv, timeout=120):
    command = shlex.join(argv)
    commands.append(command)
    result = subprocess.run([*bench.SSH, command], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Read-only remote check failed with exit {result.returncode}')
    return result.stdout

bench.remote = read_remote  # inspect() now performs no writes to the archived commands log
before = json.loads((out / "deployment-before.json").read_text())
names = [x["Name"].lstrip("/") for x in before]
after = bench.inspect(names)
original = {x["Name"]: x for x in before}
fields = ["Id", "Image", "Cmd", "Entrypoint", "RestartPolicy", "DeviceRequests", "IpcMode", "ShmSize"]
checks = {}
for current in after:
    old = original[current["Name"]]
    equal = all(current[k] == old[k] for k in fields)
    # Docker can reorder its mount array after restart; order is not configuration.
    equal &= sorted(current["Mounts"], key=lambda x: x["Destination"]) == sorted(old["Mounts"], key=lambda x: x["Destination"])
    equal &= current["Running"]
    checks[current["Name"]] = bool(equal)
assert all(checks.values()), checks
assert not bench.remote(["docker", "ps", "-a", "--filter", f"name=^{bench.CLEAN}$", "--format", "{{.Names}}"] ).strip()
print("Original IDs, image IDs, arguments, mounts and runtime settings verified; waiting for health.", flush=True)
end = time.monotonic() + 900
while True:
    raw = bench.remote(["docker", "inspect", "--format", "{{.Name}} {{json .State}}", *names])
    states = {}
    for line in raw.splitlines():
        name, value = line.split(" ", 1)
        state = json.loads(value)
        states[name] = {"running": state["Running"], "status": state["Status"],
                        "health": state.get("Health", {}).get("Status")}
    if all(x["running"] and x["health"] in (None, "healthy") for x in states.values()):
        break
    if time.monotonic() > end:
        raise TimeoutError(states)
    time.sleep(10)
http_status = bench.remote(["curl", "-k", "-s", "-o", "/dev/null", "-w", "%{http_code}", "https://127.0.0.1:11434/"]).strip()
assert 200 <= int(http_status) < 400, http_status
report = {"all_original_configurations_match": all(checks.values()),
    "checks": checks, "mount_comparison": "sorted by Destination; Docker array order is immaterial",
    "states": states, "experimental_container_removed": True, "nginx_root_http_status": int(http_status)}
if args.output is not None:
    (args.output / 'restoration-verified.json').write_text(json.dumps(report, indent=2) + '\n')
    (args.output / 'gpu-restored.json').write_text(json.dumps({'nvidia_smi': bench.remote(['nvidia-smi'])}, indent=2) + '\n')
    (args.output / 'commands.log').write_text('\n'.join(commands) + '\n')
print(json.dumps(report, indent=2))
print("All original containers ready; nginx responds; experimental container removed.", flush=True)
