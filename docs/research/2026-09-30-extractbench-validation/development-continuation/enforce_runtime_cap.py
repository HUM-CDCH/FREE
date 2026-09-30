"""Apply the user's later two-hour wall cap without changing the running study.

Linux only. The pidfd refers to this runner, never a reused process ID.
"""
import json
import os
import select
import signal
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

root = Path(sys.argv[1]).resolve()
processes = json.loads((root / 'detached-processes.json').read_text())
started = json.loads((root / 'runner-started.json').read_text())
pid = processes['runner_pid']
fd = os.pidfd_open(pid)
actual = Path(f'/proc/{pid}/cmdline').read_bytes().rstrip(b'\0').split(b'\0')
assert [s.decode() for s in actual] == processes['command'], 'Runner process identity changed'
poller = select.poll()
poller.register(fd, select.POLLIN)
deadline = datetime.fromisoformat(started['at']) + timedelta(hours=2)
admission_end = deadline - timedelta(seconds=started['drain_timeout_seconds'])
now = datetime.now(UTC)
hard_mono = time.monotonic() + (deadline - now).total_seconds()
admit_mono = hard_mono - started['drain_timeout_seconds']

def record(name, value):
    with (root / name).open('x') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')

record('runtime-cap-amendment.json', {
    'at': now.isoformat(), 'user_elapsed_hours': 2, 'runner_pid': pid,
    'original_start': started['at'], 'original_admission_hours': started['hours'],
    'admission_deadline_utc': admission_end.isoformat(),
    'hard_deadline_utc': deadline.isoformat(),
    'method': 'STOP_REQUESTS before drain window; pidfd SIGTERM only if still running at wall cap',
    'fresh_call_cap': 400, 'inference_settings_changed': False})
stopped = False
while True:
    if poller.poll(0):
        record('runtime-cap-finished.json', {'at': datetime.now(UTC).isoformat(),
            'status': 'runner_exited', 'stop_file_written': stopped})
        break
    remaining = hard_mono - time.monotonic()
    if not stopped and time.monotonic() >= admit_mono:
        (root / 'STOP_REQUESTS').touch(exist_ok=True)
        record('runtime-cap-stop.json', {'at': datetime.now(UTC).isoformat()})
        stopped = True
    if remaining <= 0:
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        record('runtime-cap-finished.json', {'at': datetime.now(UTC).isoformat(),
            'status': 'terminated_at_wall_cap', 'stop_file_written': stopped,
            'reconciliation_required': True})
        break
    time.sleep(min(1, remaining))
os.close(fd)
