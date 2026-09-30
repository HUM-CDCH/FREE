"""Synthetic, serial comparison. Run from repository root; see README.md.

No production code or dataset is changed. Existing containers are stopped,
never recreated, and restarted in finally. Commands are logged without secrets.
TTFT/decode timing comes from isolated server metrics so requests stay nonstreaming.
"""
from __future__ import annotations

import hashlib
import json
import shlex
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / "prototypes/parsing_service"
sys.path[:0] = [str(SERVICE), str(SERVICE / "src")]
from experiments.harness.config import Config
from experiments.harness.data import Case, inline_evidence
from experiments.harness.extract import chunks_of, reply_schema, system_prompt, user_prompt
from experiments.harness.model import Provider, ResearchChat
from experiments.harness.run import run_case
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.tokens import counter_for
from kei_exp.kie.extract.llm import _plain

OUT = Path(__file__).resolve().parent
MODEL = "Qwen/Qwen3.8-27B-FP8"
REVISION = "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
IMAGE = "sha256:8ca4c87cf4ec334bee35ac29c6bc30bf43760f17735b308ddff49dcb5fda2daa"
EXISTING = "free-extraction_model-1"
CLEAN = "extractbench-bare-20260930"
SSH = ["ssh", "-F", "/home/gebbaro/.ssh/config", "-o", "BatchMode=yes", "baratheon"]


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def remote(argv, timeout=120):
    command = shlex.join(argv)
    with (OUT / "commands.log").open("a") as f:
        f.write(command + "\n")
    r = subprocess.run([*SSH, command], capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        # docker inspect partial stdout can include environment secrets.
        raise RuntimeError(f"{command}: exit {r.returncode}; {r.stderr[:1000]}")
    return r.stdout


def inspect(names):
    # Deliberately omit Config.Env: deployments can carry credentials.
    raw = json.loads(remote(["docker", "inspect", *names]))
    return [{"Id": x["Id"], "Name": x["Name"], "Image": x["Image"],
             "Running": x["State"]["Running"], "Entrypoint": x["Config"]["Entrypoint"],
             "Cmd": x["Config"]["Cmd"], "Mounts": x["Mounts"],
             "RestartPolicy": x["HostConfig"]["RestartPolicy"],
             "DeviceRequests": x["HostConfig"]["DeviceRequests"],
             "IpcMode": x["HostConfig"]["IpcMode"], "ShmSize": x["HostConfig"]["ShmSize"],
             "Networks": x["NetworkSettings"]["Networks"]} for x in raw]


class NoResponseCache(Provider):
    # cache=None alone still caches in memory. Disable both paths explicitly.
    def lookup(self, key):
        return None

    def store(self, key, request, reply):
        pass


def synthetic():
    schema = Schema.model_validate({"recordDescription": "a synthetic instrument in a laboratory inventory",
        "schemaNodes": [{"id": n, "name": n, "type": t} for n, t in
                        [("name", "string"), ("code", "string"), ("quantity", "integer"), ("location", "string")]]})
    passages = [{"id": f"p1_s{i}", "page": 1,
        "text": f"Name: Synthetic instrument {i+1:02d}; code: SYN-{i+1:03d}; quantity: {i+2}; location: Room {101+i}."}
        for i in range(8)]
    evidence, _, _ = inline_evidence("throughput-synthetic-20260930", passages)
    case = Case("throughput-synthetic-20260930", "synthetic", "dev", evidence, schema, ())
    cfg = Config.model_validate({"input": {"mode": "layout"},
        "chunking": {"mode": "fixed", "max_chars": 4000}, "output": {"max_tokens": 512},
        "recovery": {"retries": 0, "subdivide": False, "depth": 1},
        "evidence": {"mode": "none"}, "merge": {"keys": False, "continuation": "off"},
        "sampling": {"temperature": 0, "seed": 20260930},
        "budget": {"calls": 1, "tokens": 250000, "workers": 1}})
    chunk, = chunks_of(list(evidence.passages), cfg)
    rs = reply_schema(schema.record_nodes, cfg, [p.id for p in evidence.passages])
    payload = {"model": MODEL, "temperature": 0.0, "max_tokens": 512,
        "messages": [{"role": "system", "content": system_prompt(case, schema.record_nodes, cfg, rs)},
                     {"role": "user", "content": user_prompt(chunk, cfg)}],
        "chat_template_kwargs": {"enable_thinking": False}, "seed": 20260930,
        "response_format": {"type": "json_schema", "json_schema": {"name": "reply", "schema": _plain(rs), "strict": True}}}
    save("synthetic.json", {"passages": passages, "schema": schema.model_dump(by_alias=True), "config": cfg.model_dump()})
    save("request.json", payload)
    return case, cfg, payload


def preflight_payload(case, cfg, payload):
    """Capture the full runner's body without making any HTTP request."""
    class Counter:
        context_tokens = 32768
        def request_tokens(self, *args, **kwargs):
            return 530
    class Captured(BaseException):
        pass
    original_post = requests.post
    captured = []
    def capture(url, **kwargs):
        captured.append(kwargs["json"])
        raise Captured
    requests.post = capture
    try:
        chat = ResearchChat(url="http://offline.invalid/v1/chat/completions", model=MODEL)
        provider = NoResponseCache(chat, counter=Counter())
        try:
            run_case(case, cfg, provider.view(1, 250000), admission="vllm")
        except Captured:
            pass
    finally:
        requests.post = original_post
    assert captured == [payload], "direct request differs from full harness request"
    save("preflight.json", {"no_http_sent": True, "identical_payload": True, "request_sha256": digest(payload)})


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def metrics(base):
    r = requests.get(base + "/metrics", timeout=20)
    r.raise_for_status()
    result = {}
    for line in r.text.splitlines():
        if line.startswith("vllm:"):
            key, val = line.rsplit(" ", 1)
            name = key.split("{", 1)[0]
            if name.endswith(("_sum", "_count", "_total")) or name in ("vllm:num_requests_running", "vllm:num_requests_waiting"):
                result[name] = result.get(name, 0) + float(val)
    return result


def wait_health(base, timeout=1200):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if requests.get(base + "/health", timeout=3).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(3)
    raise TimeoutError(base + " not ready")


def condition(name, base, case, cfg, payload, harness=False):
    wait_health(base)
    models = requests.get(base + "/v1/models", timeout=20).json()
    save(name + "-models.json", models)
    assert models["data"][0]["max_model_len"] == 32768
    chat = ResearchChat(url=base + "/v1/chat/completions", model=MODEL, timeout=900, max_tokens=512)
    counter = counter_for(chat)
    assert counter.context_tokens == 32768
    counted = counter.request_tokens(payload["messages"][0]["content"], payload["messages"][1]["content"], None)
    assert counted + 512 <= 32768
    provider = NoResponseCache(chat, cache=None, counter=counter)
    rows = []
    for index in range(4):
        before = metrics(base)
        assert before.get("vllm:num_requests_running", 0) == before.get("vllm:num_requests_waiting", 0) == 0
        captured = []
        original_post = requests.post

        def observed_post(url, **kwargs):
            if url.endswith("/v1/chat/completions"):
                assert kwargs["json"] == payload, "harness changed the completion request"
            start = time.monotonic()
            response = original_post(url, **kwargs)
            elapsed = time.monotonic() - start
            if url.endswith("/v1/chat/completions"):
                captured.append((response.json(), elapsed, digest(kwargs["json"])))
            return response

        requests.post = observed_post
        try:
            start = time.monotonic()
            if harness:
                meter = provider.view(cfg.budget.calls, cfg.budget.tokens)
                artifact = run_case(case, cfg, meter, admission="vllm")
                save(f"{name}-{index}-artifact.json", artifact)
                assert meter.spent["fresh"]["calls"] == 1 and meter.spent["replayed"]["calls"] == 0
                assert not provider._memory and not provider._flights.keys() - set(meter.requests)
            else:
                response = requests.post(chat.url, json=payload, timeout=900)
                response.raise_for_status()
            wall = time.monotonic() - start
        finally:
            requests.post = original_post
        assert len(captured) == 1
        response, http_seconds, body_hash = captured[0]
        save(f"{name}-{index}-response.json", response)
        end = time.monotonic() + 30
        while True:
            after = metrics(base)
            completed = after.get("vllm:request_success_total", 0) - before.get("vllm:request_success_total", 0)
            if completed >= 1:
                break
            if time.monotonic() > end:
                raise TimeoutError("server metrics did not publish request")
            time.sleep(0.2)
        assert completed == 1, "another client contaminated the measurement"
        delta = {key: after.get(key, 0) - before.get(key, 0) for key in set(before) | set(after)}
        assert delta["vllm:time_to_first_token_seconds_count"] == 1
        assert delta["vllm:request_decode_time_seconds_count"] == 1
        n = response["usage"]["completion_tokens"]
        assert n == delta["vllm:request_generation_tokens_sum"] and n <= 512
        assert response["usage"]["prompt_tokens"] == counted
        ttft = delta["vllm:time_to_first_token_seconds_sum"]
        decode = delta["vllm:request_decode_time_seconds_sum"]
        row = {"condition": name, "warmup": index == 0, "index": index,
            "input_tokens": counted, "output_tokens": n,
            "finish_reason": response["choices"][0]["finish_reason"], "ttft_server_seconds": ttft,
            "decode_seconds": decode, "decode_tokens_per_second": (n - 1) / decode,
            "http_e2e_seconds": http_seconds, "condition_e2e_seconds": wall,
            "server_e2e_seconds": delta["vllm:e2e_request_latency_seconds_sum"],
            "request_sha256": body_hash, "response_text_sha256": digest(response["choices"][0]["message"]),
            "metric_before": before, "metric_after": after, "metric_delta": delta}
        rows.append(row)
        save(name + "-results.json", rows)
        print(json.dumps({k: v for k, v in row.items() if not k.startswith("metric_")}), flush=True)
    return rows


def main():
    if (OUT / "deployment-before.json").exists():
        raise RuntimeError("Evidence exists; use a separate output directory for another run")
    if remote(["docker", "ps", "-a", "--filter", f"name=^{CLEAN}$", "--format", "{{.ID}}"] ).strip():
        raise RuntimeError("Experimental container name already exists; nothing was stopped or removed")
    case, cfg, payload = synthetic()
    preflight_payload(case, cfg, payload)
    available = remote(["docker", "ps", "--format", "{{.Names}}"] ).splitlines()
    # Other projects may create/remove temporary containers during the experiment.
    known = [EXISTING, "free-ocr_model-1", "free-nuextract_model-1", "free-parsing_worker-1",
             "free-parsing_service-1", "free-studio-1", "free-nginx-1", "free-db-1",
             "free-phoenix-1", "free-validation-pg"]
    names = [name for name in known if name in available]
    before = inspect(names)
    save("deployment-before.json", before)
    original = next(x for x in before if x["Name"] == "/" + EXISTING)
    assert original["Image"] == IMAGE and original["Entrypoint"] == ["vllm", "serve"]
    save("gpu-before.json", {"nvidia_smi": remote(["nvidia-smi"])})
    # Save content-addressed cache file identities plus deployed metric semantics.
    pin_code = """import json,pathlib,hashlib,vllm,torch,transformers
p=pathlib.Path('/models/huggingface/hub/models--Qwen--Qwen3.8-27B-FP8')
s=p/'snapshots'/p.joinpath('refs/main').read_text().strip()
c=json.loads((s/'config.json').read_text())
print(json.dumps({'revision':s.name,'vllm':vllm.__version__,'torch':torch.__version__,'transformers':transformers.__version__,'architectures':c.get('architectures'),'model_type':c.get('model_type'),'text_config':c.get('text_config'),'config_sha256':hashlib.sha256((s/'config.json').read_bytes()).hexdigest(),'files':[{'name':x.name,'target':str(x.resolve()),'bytes':x.stat().st_size,'inode':x.stat().st_ino} for x in sorted(s.iterdir()) if x.is_file()],'stats_source':str(pathlib.Path(vllm.__file__).parent/'v1/metrics/stats.py')},indent=2))"""
    pin = json.loads(remote(["docker", "exec", EXISTING, "python3", "-c", pin_code]))
    save("cache-and-version.json", pin)
    assert pin["revision"] == REVISION
    stats = remote(["docker", "exec", EXISTING, "cat", pin["stats_source"]])
    (OUT / "vllm-stats-source.py").write_text(stats)
    # Isolate inference from app traffic and other resident GPU engines.
    pause = [x for x in ["free-nginx-1", "free-studio-1", "free-parsing_worker-1", "free-parsing_service-1",
                        "free-ocr_model-1", "free-nuextract_model-1"] if x in names]
    stopped = []
    tunnel = None
    clean_id = None
    try:
        # Requests on all resident models must be idle before changing deployment.
        for model in [EXISTING, "free-ocr_model-1", "free-nuextract_model-1"]:
            if model in names:
                text = remote(["docker", "exec", model, "python3", "-c",
                    "import requests; print('\\n'.join(x for x in requests.get('http://localhost:8000/metrics').text.splitlines() if x.startswith(('vllm:num_requests_running{','vllm:num_requests_waiting{'))))"])
                assert all(float(x.rsplit(' ', 1)[1]) == 0 for x in text.splitlines()), "active user request"
        for name in pause:
            stopped.append(name)
            remote(["docker", "stop", "--time", "30", name])
        ip = original["Networks"]["free_app"]["IPAddress"]
        tunnel = subprocess.Popen([*SSH[:-1], "-o", "ExitOnForwardFailure=yes", "-N",
            "-L", f"127.0.0.1:18180:{ip}:8000", "-L", "127.0.0.1:18181:127.0.0.1:18081", SSH[-1]],
            stdout=(OUT / "tunnel.log").open("w"), stderr=subprocess.STDOUT)
        time.sleep(2)
        assert tunnel.poll() is None
        save("gpu-existing-only.json", {"nvidia_smi": remote(["nvidia-smi"])})
        a = condition("direct-existing", "http://127.0.0.1:18180", case, cfg, payload)
        stopped.append(EXISTING)
        remote(["docker", "stop", "--time", "30", EXISTING])
        assert "VLLM::EngineCore" not in remote(["nvidia-smi"]), "GPU engine remains resident"
        command = ["docker", "run", "-d", "--name", CLEAN, "--gpus", "all", "--shm-size", "2g",
            "--network", "free_app", "-p", "127.0.0.1:18081:8000",
            "-v", "free_parsing-models:/models", "-e", "HF_HOME=/models/huggingface",
            "-e", "HF_HUB_OFFLINE=1", "-e", "TRANSFORMERS_OFFLINE=1",
            "--entrypoint", "vllm", IMAGE, "serve", *original["Cmd"], "--revision", REVISION]
        created = remote(command).strip()
        if len(created) != 64 or any(c not in "0123456789abcdef" for c in created):
            raise RuntimeError("Docker did not return a full created-container ID")
        clean_id = created
        save("created-container.json", {"id": clean_id, "name": CLEAN})
        print("Fresh bare vllm serve container starting", flush=True)
        wait_health("http://127.0.0.1:18181")
        save("deployment-clean.json", inspect([CLEAN]))
        clean_pin = json.loads(remote(["docker", "exec", CLEAN, "python3", "-c", pin_code]))
        save("clean-cache-and-version.json", clean_pin)
        assert pin == clean_pin
        save("gpu-clean-only.json", {"nvidia_smi": remote(["nvidia-smi"])})
        b = condition("direct-clean", "http://127.0.0.1:18181", case, cfg, payload)
        c = condition("harness-clean", "http://127.0.0.1:18181", case, cfg, payload, harness=True)
        save("all-results.json", a + b + c)
    finally:
        # Never start the original engine before stopping the experimental one.
        try:
            if clean_id is not None:
                try:
                    (OUT / "clean-server.log").write_text(remote(["docker", "logs", clean_id]))
                finally:
                    remote(["docker", "rm", "-f", clean_id])
        finally:
            # Restore engines, then request-serving applications in dependency order.
            order = [EXISTING, "free-ocr_model-1", "free-nuextract_model-1",
                     "free-parsing_service-1", "free-parsing_worker-1", "free-studio-1", "free-nginx-1"]
            errors = []
            for name in order:
                if name in stopped:
                    try:
                        remote(["docker", "start", name])
                    except Exception as e:
                        errors.append(str(e))
            save("deployment-after.json", inspect(names))
            save("restoration.json", {"errors": errors, "original_containers_preserved":
                all(a["Id"] == b["Id"] and a["Image"] == b["Image"] and a["Cmd"] == b["Cmd"]
                    and a["Entrypoint"] == b["Entrypoint"]
                    and sorted(a["Mounts"], key=lambda x: x["Destination"]) == sorted(b["Mounts"], key=lambda x: x["Destination"])
                    and a["RestartPolicy"] == b["RestartPolicy"] and b["Running"]
                    for a, b in zip(before, inspect(names), strict=True))})
            if tunnel:
                tunnel.terminate()
                tunnel.wait(timeout=10)
            if errors:
                raise RuntimeError("Restoration errors: " + str(errors))


if __name__ == "__main__":
    main()
