"""The model integration checks without a GPU or downloads: every VLM record's Docling run against a fake vLLM
server, whole and streamed; the Surya adapter over a patched predictor; Surya's real client and RecognitionPredictor
over canned outputs; the server launcher; the CLI's refusals. Every cut runs the layout model on CPU, so the module
takes a couple of minutes. Every output and debug directory is under tmp_path: nothing lands in runs/ or scratch/."""
import json
import re
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Thread
from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

from kei_exp.convert import main
from kei_exp.kie.runner import convert
from kei_exp.kie.stages.ocr import resolve
from kei_exp.models import MODELS
from kei_exp.transcription.specs import VLM_SPECS
from kei_exp.transcription.surya import KeptOutputs, _InferenceManager, where
from kei_exp.transcription.types import ConversionError, RunParams
from kei_exp.transcription.vlm import vlm_options

VLM_RECORDS = [name for name in MODELS if name != "surya"]


class _Server(ThreadingHTTPServer):
    fake: "FakeVllm"


def sse(event: dict) -> bytes:
    return ("data: " + json.dumps(event) + "\n\n").encode()


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # the base class's own parameter names
        pass

    def do_POST(self):
        fake = cast(_Server, self.server).fake
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        fake.requests.append(payload)
        text = "# Kreis Heide\n\nGrüße: 76. Adorf."
        if payload["model"] == MODELS["granite_docling"].repo:
            text = "<doctag><text><loc_0><loc_0><loc_500><loc_500>Grüße: 76. Adorf.</text></doctag>"
        else:
            text += "\n\n76. First site\n\n1. Find\n\n77. Second site"
        if payload["model"] == MODELS["infinity_parser"].repo:
            text = "```markdown\n" + text + "\n```"
        usage = {"prompt_tokens": 50, "completion_tokens": 25, "total_tokens": 75}
        prompt = payload["messages"][0]["content"][1]["text"]
        if prompt in fake.surya_replies:
            text, usage = fake.surya_replies[prompt].pop(0)
        self.send_response(200)
        # Text goes out in pieces, with a logprob per piece when the request asks for them, so the streamed and
        # the whole completion carry the same information.
        step = max(1, -(-len(text) // 3))
        pieces = [text[i:i + step] for i in range(0, len(text), step)] or [""]
        logprobs = ([{"token": piece, "logprob": -0.5, "bytes": None, "top_logprobs": []} for piece in pieces]
                    if payload.get("logprobs") else None)
        if payload.get("stream"):
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for index, piece in enumerate(pieces):
                choice = {"delta": {"content": piece}}
                if logprobs:
                    choice["logprobs"] = {"content": logprobs[index:index + 1]}
                self.wfile.write(sse({"choices": [choice]}))
                self.wfile.flush()
                if index == 0 and prompt == "stream-early":  # the rest waits until the sink has the first piece
                    fake.early_arrival.append(fake.token_seen.wait(5))
            if usage == "cut":
                return  # the connection closes with no finish reason, usage or [DONE]
            self.wfile.write(sse({"choices": [{"delta": {}, "finish_reason": fake.finish_reason}]}))
            self.wfile.write(sse({"choices": [], "usage": usage}))
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            choice = {"index": 0, "message": {"role": "assistant", "content": text},
                      "finish_reason": fake.finish_reason}
            if logprobs:
                choice["logprobs"] = {"content": logprobs}
            self.wfile.write(json.dumps({"id": "test", "created": 0, "choices": [choice], "usage": usage}).encode())


class FakeVllm:
    """A vLLM stand-in on a free port: one canned completion per record, whole or streamed, and the state the tests
    read and turn. `requests` is every payload it saw; `finish_reason` is what every completion reports;
    `surya_replies` scripts the answers to Surya's prompts; `token_seen` and `early_arrival` are the stream-early
    hand-off between the streaming sink and the server."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.finish_reason = "stop"
        self.surya_replies: dict[str, list] = {}  # prompt -> successive HTTP responses, incl. attempts Surya retries
        self.token_seen = Event()  # set by the streaming sink on stream-early's first piece
        self.early_arrival: list[bool] = []  # whether the server saw that before it sent the rest
        self.server = _Server(("127.0.0.1", 0), _Handler)
        self.server.fake = self
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1/chat/completions"


@pytest.fixture(scope="module")
def fake() -> Iterator[FakeVllm]:
    """The fake vLLM server, up for the module."""
    fake = FakeVllm()
    try:
        yield fake
    finally:
        fake.server.shutdown()
        fake.server.server_close()


def exit_code(*args: str) -> int | str | None:
    """main() over the CLI arguments: its exit code when it refuses, None when it writes the Markdown."""
    with patch("sys.argv", ["kei-exp", *args]):
        try:
            main()
        except SystemExit as error:
            return error.code
    return None


# --- Docling's VLM path: every record against the fake server, whole and streamed -----------------------------------


@pytest.mark.parametrize("stream", [False, True], ids=["whole", "streamed"])
@pytest.mark.parametrize("model", VLM_RECORDS)
def test_each_vlm_record_converts_the_scan_and_refuses_a_truncated_output(model, stream, fake, scan_pdf, tmp_path,
                                                                          monkeypatch):
    output = tmp_path / model
    argv = [str(scan_pdf), "--model", model, "--url", fake.url,
            "--output-dir", str(output), "--max-output-tokens", "128"]
    if stream:
        argv += ["--stream"]
    assert exit_code(*argv) is None
    markdown = (output / f"{scan_pdf.stem}.md").read_text(encoding="utf-8")
    assert "Grüße: 76. Adorf." in markdown, (model, stream, markdown)
    payload = fake.requests[-1]
    assert payload["model"] == MODELS[model].repo and payload["max_tokens"] == 128
    assert payload["messages"][0]["content"][1]["text"] == vlm_options(MODELS[model], fake.url, 1200).model_spec.prompt
    if model == "granite_docling":
        assert payload["skip_special_tokens"] is False
    else:
        assert "76. First site\n\n1. Find\n\n77. Second site" in markdown
    if model == "infinity_parser":
        assert payload["chat_template_kwargs"] == {"enable_thinking": False}
        assert not markdown.startswith("```markdown") and not markdown.endswith("```")
    if model == "granite_vision":
        assert payload["repetition_penalty"] == 1.05
    monkeypatch.setattr(fake, "finish_reason", "length")  # "stop" again at teardown
    assert exit_code(*argv) == 1, "Truncated output accepted"
    assert (output / f"{scan_pdf.stem}.md").read_text(encoding="utf-8") == markdown


def test_an_output_override_leaves_the_presets_pristine(fake):
    vlm_options(MODELS["nanonets_ocr2"], fake.url, 1200, max_output_tokens=128)
    assert vlm_options(MODELS["nanonets_ocr2"], fake.url, 1200).model_spec.max_new_tokens == 15000  # Presets stay pristine.
    vlm_options(MODELS["infinity_parser"], fake.url, 1200, max_output_tokens=128)
    spec = VLM_SPECS["infinity_parser"]
    assert spec.max_new_tokens == 16384  # The custom spec stays pristine too.


# --- The Surya adapter over a patched RecognitionPredictor ----------------------------------------------------------


def block(html: str, skipped: bool = False) -> SimpleNamespace:
    return SimpleNamespace(html=html, skipped=skipped, error=False)


def bare(text: str) -> SimpleNamespace:
    return SimpleNamespace(blocks=[block(text)], model_dump=lambda mode: {"blocks": 1})


PAGE = SimpleNamespace(blocks=[block("<h2>Kreis Heide</h2>"), block("<p>Grüße: 76. Adorf.</p>"),
                               block("<p>Figure</p>", skipped=True)], model_dump=lambda mode: {"blocks": 3})
# The first crop continues a section: a page number and a paragraph before any heading, as on most pages.
LEAD = SimpleNamespace(blocks=[block("160"), block("<p>Cdorf/Stadt, G, 529. Ddorf, vS.</p>")],
                       model_dump=lambda mode: {"blocks": 2})


@pytest.fixture
def predictor() -> Iterator[MagicMock]:
    """Surya's RecognitionPredictor patched out, answering LEAD for the first crop and PAGE for every other one until
    a test sets its own side_effect; the inference manager is patched too, so no server is contacted."""
    with patch("surya.recognition.RecognitionPredictor") as predictor, patch("kei_exp.transcription.surya._InferenceManager"):
        predictor.return_value.side_effect = lambda images: [LEAD if index == 0 else PAGE for index in range(len(images))]
        yield predictor


@pytest.fixture
def surya_argv(fake, scan_pdf, tmp_path) -> list[str]:
    """The CLI arguments of a Surya run over the scan, its Markdown and debug report under tmp_path."""
    return [str(scan_pdf), "--model", "surya", "--url", fake.url,
            "--output-dir", str(tmp_path / "surya"), "--debug-dir", str(tmp_path / "surya-debug")]


def test_surya_keeps_everything_before_the_first_heading(predictor, surya_argv, scan_pdf, tmp_path):
    assert exit_code(*surya_argv) is None
    # the knob Surya accepts now; the patched predictor streams nothing
    assert exit_code(*surya_argv, "--stream") is None
    # Everything before the first heading is kept: Docling's HTML backend would take it for page furniture.
    markdown = (tmp_path / "surya" / f"{scan_pdf.stem}.md").read_text(encoding="utf-8")
    assert markdown.startswith("160\n\nCdorf/Stadt, G, 529. Ddorf, vS.\n\n## Kreis Heide"), markdown[:120]


def test_surya_leaves_skipped_blocks_out_and_writes_the_debug_files(predictor, surya_argv, scan_pdf, tmp_path):
    assert exit_code(*surya_argv) is None
    markdown = (tmp_path / "surya" / f"{scan_pdf.stem}.md").read_text(encoding="utf-8")
    assert "## Kreis Heide" in markdown and "Grüße: 76. Adorf." in markdown and "Figure" not in markdown
    assert (tmp_path / "surya-debug" / "page-1.png").exists() and (tmp_path / "surya-debug" / "report.json").exists()


def test_surya_is_pointed_at_the_server(predictor, surya_argv, fake):
    assert exit_code(*surya_argv) is None
    from surya.settings import settings  # the adapter assigns Surya's settings after import
    assert settings.SURYA_INFERENCE_URL == fake.url.removesuffix("/chat/completions")
    assert settings.SURYA_INFERENCE_BACKEND == "vllm"


def test_surya_gets_the_four_column_crops_and_the_report_names_them(predictor, surya_argv, tmp_path):
    assert exit_code(*surya_argv) is None
    images = predictor.return_value.call_args.args[0]
    assert len(images) == 4 and all(800 < image.size[0] < 900 for image in images)  # column crops at 250 dpi
    report = json.loads((tmp_path / "surya-debug" / "report.json").read_text(encoding="utf-8"))
    assert [entry["region"]["kind"] for entry in report["pages"]] == ["column"] * 4
    assert report["transcriber"] == "surya" and report["status"] == "success" and report["prompt"] is None
    assert report["pages"][0]["region"]["ink"] > 0 and report["pages"][0]["output_tokens"] is None


def test_cut_none_hands_surya_the_whole_spread_at_192_dpi(predictor, surya_argv):
    assert exit_code(*surya_argv, "--cut", "none") is None
    images = predictor.return_value.call_args.args[0]
    assert len(images) == 1 and images[0].size[0] > 3000  # 192 dpi render of the whole spread


def test_a_one_page_range_still_yields_its_columns(predictor, surya_argv):
    assert exit_code(*surya_argv, "--pages", "1") is None
    assert len(predictor.return_value.call_args.args[0]) == 4  # the one-page range still yields its columns


@pytest.mark.parametrize("cut", [[], ["--cut", "none"]], ids=["auto", "none"])
def test_a_page_range_outside_the_document_is_refused_before_surya_runs(cut, predictor, surya_argv):
    # With whole pages the range is checked before Surya's loader, which would only assert.
    code = exit_code(*surya_argv, *cut, "--pages", "2-3")
    assert code == 1, f"Out-of-range pages accepted with {cut}"  # one-page document: the range is out of bounds
    assert not predictor.return_value.called  # Surya never ran


def test_a_surya_failure_is_refused(predictor, surya_argv):
    # Surya's own failures (an unreachable server, a model mismatch) are refused like any other bad run.
    predictor.return_value.side_effect = RuntimeError("Model mismatch at http://127.0.0.1:9/v1: expected 'x'")
    assert exit_code(*surya_argv) == 1, "A Surya failure was accepted"


def test_the_records_allowance_and_decoding_settings_are_pinned_at_every_run(predictor, surya_argv, monkeypatch):
    from surya.settings import settings  # the adapter assigns Surya's settings after import
    predictor.return_value.side_effect = lambda images: [PAGE] * len(images)
    # The record's four decoding settings are pinned at every run, whatever the environment left in them.
    monkeypatch.setattr(settings, "SURYA_GUIDED_LAYOUT", False)
    monkeypatch.setattr(settings, "SURYA_MAX_TOKENS_LAYOUT", 1)
    assert exit_code(*surya_argv) is None
    assert settings.SURYA_MAX_TOKENS_FULL_PAGE == 16384  # The record's allowance reaches Surya.
    assert (settings.SURYA_GUIDED_LAYOUT, settings.SURYA_FULLPAGE_REGEN, settings.SURYA_MAX_TOKENS_LAYOUT,
            settings.SURYA_MAX_TOKENS_BLOCK_CEILING) == (True, False, 3072, 8192)


def test_each_crop_is_converted_on_its_own(predictor, surya_argv, scan_pdf, tmp_path):
    # Each crop is converted on its own: two tagless blocks meeting at a crop boundary stay two paragraphs,
    # where one conversion of the joined HTML would have run them into one line ("160 161").
    predictor.return_value.side_effect = lambda images: [bare("160"), bare("161")] + [PAGE] * (len(images) - 2)
    assert exit_code(*surya_argv) is None
    markdown = (tmp_path / "surya" / f"{scan_pdf.stem}.md").read_text(encoding="utf-8")
    assert markdown.startswith("160\n\n161\n\n## Kreis Heide"), markdown[:80]


# --- Surya's real client against the fake server, whole and streamed ------------------------------------------------


def usage(input_tokens, output_tokens):
    return {"prompt_tokens": input_tokens, "completion_tokens": output_tokens,
            "total_tokens": (input_tokens or 0) + output_tokens}


REPLIES = {
    "usage-retry": [("<p>again</p>" * 200, usage(999, 9000)), ("kept retry answer", usage(11, 7))],
    "usage-zero": [("zero prompt answer", usage(0, 3))],
    "usage-missing": [("missing prompt answer", {"completion_tokens": 5, "total_tokens": 5})],
    "usage-lost": [("<p>again</p>" * 200, usage(888, 9000)), ("unreported final answer", None)],
}
# Streamed only: a reply cut off before its finish reason is retried, and the first piece reaches the sink
# before the reply is complete (the server holds the rest until the sink has it, five seconds at most).
STREAMED_ONLY = {"stream-cut": [("half an answer", "cut"), ("whole answer", usage(5, 2))],
                 "stream-early": [("early answer", usage(4, 2))]}


class SuryaClient:
    """Surya's request/retry helpers over the real OpenAI client against the fake server, one 16 px page per prompt:
    whole with no sink, or streamed into `sink`, which sets the fake's token_seen on stream-early's first piece.
    Exercises the real OpenAI client and Surya request/retry helpers, not a fabricated BatchOutputItem."""

    def __init__(self, fake: FakeVllm) -> None:
        self.fake = fake
        self.events: list[dict] = []
        self.images = [Image.new("RGB", (16, 16), color)
                       for color in ["red", "green", "blue", "white", "black", "gray"]]

    def sink(self, event: dict) -> None:
        self.events.append(event)
        if event["type"] == "token" and event["page"] == 6:  # stream-early
            self.fake.token_seen.set()

    def generate(self, live) -> tuple[KeptOutputs, list]:
        """The manager and the outputs of one pass over the prompts, the streamed-only ones included with a sink."""
        from openai import OpenAI
        from surya.inference.schema import BatchInputItem

        prompts = list(REPLIES) + (list(STREAMED_ONLY) if live else [])
        self.fake.surya_replies.update({prompt: list(attempts)
                                        for prompt, attempts in {**REPLIES, **STREAMED_ONLY}.items()})
        with OpenAI(base_url=self.fake.url.removesuffix("/chat/completions"), api_key="test") as client, \
                patch("kei_exp.transcription.surya.sleep"):
            backend = SimpleNamespace(_client=client, _client_parallel=lambda: 4,
                                      start=lambda: SimpleNamespace(model_name=MODELS["surya"].repo))
            with patch("surya.inference.SuryaInferenceManager", return_value=SimpleNamespace(backend=backend)):
                manager = KeptOutputs(_InferenceManager(live), self.images[:len(prompts)], live)
            outputs = manager.generate([
                BatchInputItem(image=image, prompt_type="high_accuracy_bbox", prompt=prompt, max_tokens=16384,
                               metadata={"page_idx": index})
                for index, (image, prompt) in enumerate(zip(self.images, prompts))
            ])
        return manager, outputs


@pytest.fixture
def surya_client(fake, monkeypatch) -> SuryaClient:
    """A client over the fake with its own scripted replies and stream-early hand-off, the fake's put back after."""
    monkeypatch.setattr(fake, "surya_replies", {})
    monkeypatch.setattr(fake, "token_seen", Event())
    monkeypatch.setattr(fake, "early_arrival", [])
    return SuryaClient(fake)


def test_the_kept_usage_logprobs_and_confidence_do_not_depend_on_the_stream_knob(surya_client):
    # Concurrent pages have different counts; a looping first attempt must not leak into the kept totals.
    # The same replies go through the whole-completion path and, with a sink, the streamed one: the kept
    # numbers, the logprobs and the confidence must not depend on the knob.
    outputs = {}
    for live in [None, surya_client.sink]:
        manager, outputs[live is not None] = surya_client.generate(live)
        assert [(manager.kept(index).input_tokens, manager.kept(index).tokens) for index in range(4)] == [
            (11, 7), (0, 3), (None, 5), (None, 0),
        ], live
    assert (manager.kept(4).input_tokens, manager.kept(4).tokens) == (5, 2)
    whole, streamed = outputs[False], outputs[True][:4]
    assert [o.raw for o in streamed] == [o.raw for o in whole]
    assert [o.mean_token_prob for o in streamed] == [o.mean_token_prob for o in whole] and whole[1].mean_token_prob
    assert [o.logprobs for o in streamed] == [o.logprobs for o in whole]


def test_the_sink_sees_every_attempt_and_the_first_piece_before_the_reply_is_complete(surya_client, fake):
    surya_client.generate(surya_client.sink)
    events = surya_client.events
    # One page_start per attempt, that attempt's tokens, one page_end after the retries; the sink had the first
    # piece of stream-early while the server was still holding the rest.

    def kinds(page):
        seen = [e["type"] for e in events if e.get("page") == page]
        return [kind for i, kind in enumerate(seen) if i == 0 or kind != seen[i - 1]]

    def text(page):
        return "".join(e["text"] for e in events if e["type"] == "token" and e["page"] == page)

    assert kinds(2) == ["page_start", "token", "page_end"], kinds(2)
    assert kinds(1) == kinds(5) == ["page_start", "token", "page_start", "token", "page_end"], (kinds(1), kinds(5))
    ends = {e["page"]: e for e in events if e["type"] == "page_end"}
    assert sorted(ends) == [1, 2, 3, 4, 5, 6] and [e["type"] for e in events].count("page_end") == 6
    assert {e["stop_reason"] for e in ends.values()} == {"end_of_sequence"} and ends[5]["output_tokens"] == 2
    assert text(2) == "zero prompt answer" and text(5) == "half an answerwhole answer", (text(2), text(5))
    assert fake.early_arrival == [True], fake.early_arrival


# --- The token guard: Surya's real RecognitionPredictor over a fake inference manager with canned outputs ----------


class FakeSurya:
    """Surya's real RecognitionPredictor runs against this fake inference manager with canned outputs, so the fallback
    renumbering, the layout batches and the skipped blocks are Surya's own. The wrapper compares every request with
    its own max_tokens: 16,384 for a full page, 3,072 for layout, count + 100 for a block."""

    def __init__(self, full_page, layout=(), block=(), input_by_request=()):
        self.canned = {"high_accuracy_bbox": dict(full_page), "layout": dict(layout), "block": dict(block)}
        self.pages, self.subset = {}, []  # id(page image) -> page index; fallback pages in layout-batch order
        self.input_by_request = dict(input_by_request)

    def generate(self, batch):
        from surya.inference.schema import BatchOutputItem
        if batch and batch[0].prompt_type == "layout":
            self.subset = []
        outputs = []
        for item in batch:
            if item.prompt_type == "high_accuracy_bbox":
                page = item.metadata["page_idx"]
                self.pages[id(item.image)] = page
            elif item.prompt_type == "layout":
                page = self.pages[id(item.image)]
                self.subset.append(page)
            else:
                page = self.subset[item.metadata["page_idx"]]
            raw, tokens, *error = self.canned[item.prompt_type][page]
            outputs.append(BatchOutputItem(raw=raw, token_count=tokens, error=bool(error and error[0]),
                                           metadata={**item.metadata, "input_tokens":
                                                     self.input_by_request.get((item.prompt_type, page))}))
        return outputs


def html(text: str) -> str:
    return f'<div data-bbox="0 0 1000 1000" data-label="Text"><p>{text}</p></div>'


LOOP = "<p>again</p>" * 200  # a repetition loop: Surya rejects it and rebuilds the page from layout and blocks
LAYOUT = json.dumps([{"label": "Text", "bbox": "0 0 1000 1000", "count": 1000}])  # block budget: 1100 tokens
PICTURE = json.dumps([{"label": "Image", "bbox": "0 0 1000 1000", "count": 0}])   # nothing to OCR: no block
CLEAN = {index: (html("abcd"[index]), 3000) for index in range(4)}
BIG = json.dumps([{"label": "Text", "bbox": "0 0 1000 1000", "count": 9000}])
MIXED = json.dumps([{"label": "Image", "bbox": "0 0 1000 300", "count": 0},
                    {"label": "Text", "bbox": "0 300 1000 1000", "count": 1000}])
INPUTS = {("high_accuracy_bbox", index): 900 + index for index in range(4)}
INPUTS.update({("layout", 1): 20, ("block", 1): 30, ("layout", 3): 40, ("block", 3): 60})


@pytest.fixture
def guard(fake, scan_pdf, tmp_path):
    """convert() over the scan with a FakeSurya of canned outputs: the refusal's message (None when the run was
    accepted) and the page_stats events by crop; the debug report lands under tmp_path / surya-guard."""
    def run(full_page, layout_by_page=(), block_by_page=(), input_by_request=(), **params):
        manager = FakeSurya(full_page, layout_by_page, block_by_page, input_by_request)
        with patch("kei_exp.transcription.surya._InferenceManager", return_value=manager):
            events = []
            try:
                convert(resolve(RunParams(pdf=scan_pdf, model="surya", url=fake.url,
                                          debug_dir=tmp_path / "surya-guard", **params)), emit=events.append)
            except ConversionError as error:
                message = str(error)
            else:
                message = None
        stats = {event["crop"]: event for event in events if event["type"] == "page_stats"}
        return message, stats
    return run


def test_a_capped_full_page_is_named_and_a_rebuilt_pages_blocks_are_not_mistaken_for_it(guard):
    # Page 1 keeps a capped full-page output while page 2 loops and is rebuilt: the rebuilt page's block requests
    # are numbered within the fallback subset and must not be mistaken for page 1's.
    message, stats = guard({**CLEAN, 0: (html("a"), 16384), 1: (LOOP, 16384)}, {1: (LAYOUT, 500)},
                           {1: ("<p>b</p>", 200)})
    assert message and re.search(
        r"\bpage 1 \(source page 1, region 0\) stopped at its full page request's 16384-token cap", message), message
    assert "page 2" not in message and stats[1]["capped"] and stats[1]["output_tokens"] == 16384, (message, stats[1])
    assert not stats[2]["capped"] and stats[2]["output_tokens"] == 700 and stats[2]["blocks"] == 1, stats[2]
    assert not stats[3]["capped"] and stats[3]["output_tokens"] == 3000, stats[3]


def test_a_rebuilt_page_with_nothing_to_ocr_makes_no_block_request(guard):
    # A rebuilt page whose layout holds nothing to OCR makes no block request; its discarded loop must not count.
    message, stats = guard({**CLEAN, 1: (LOOP, 16384)}, {1: (PICTURE, 500)})
    assert message is None and not stats[2]["capped"] and stats[2]["output_tokens"] == 500, (message, stats[2])
    assert stats[2]["blocks"] == 1 and stats[2]["skipped"] == 1, stats[2]


def test_a_capped_layout_request_truncates_the_rebuilt_page(guard):
    # A capped layout request or a capped block request truncates the rebuilt page, and the error says which.
    message, stats = guard({**CLEAN, 1: (LOOP, 16384)}, {1: (LAYOUT, 3072)}, {1: ("<p>b</p>", 200)})
    assert message and re.search(
        r"\bpage 2 \(source page 1, region 1\) stopped at its layout request's 3072-token cap", message), message
    assert stats[2]["capped"] and stats[2]["output_tokens"] == 3272 and not stats[1]["capped"], stats


def test_a_capped_block_request_truncates_the_rebuilt_page_and_the_report_says_so(guard, tmp_path):
    message, stats = guard({**CLEAN, 1: (LOOP, 16384)}, {1: (LAYOUT, 500)}, {1: ("<p>b</p>", 1100)})
    assert message and re.search(r"\bpage 2\b.* stopped at its block request's 1100-token estimate", message), message
    assert stats[2]["capped"] and stats[2]["output_tokens"] == 1600, stats[2]
    report = json.loads((tmp_path / "surya-guard" / "report.json").read_text(encoding="utf-8"))
    assert report["pages"][1]["output_tokens"] == 1600 and report["pages"][1]["capped"] and not report["pages"][0]["capped"]


def test_a_block_beyond_suryas_ceiling_is_capped_at_the_ceiling(guard):
    # A block whose estimate exceeds Surya's ceiling is capped at the ceiling, which a setting can raise.
    message, _ = guard({**CLEAN, 1: (LOOP, 16384)}, {1: (BIG, 500)}, {1: ("<p>b</p>", 8192)})
    assert message and re.search(r"\bpage 2\b.* stopped at its block request's 8192-token ceiling", message), message


def test_two_rebuilt_pages_index_the_fallback_subset_and_skip_the_picture(guard):
    # Two rebuilt pages, the first with a picture before its text block: block requests index the fallback
    # subset and skip the picture, and every token lands on its own page.
    message, stats = guard({**CLEAN, 1: (LOOP, 16384), 3: (LOOP, 16384)}, {1: (MIXED, 400), 3: (LAYOUT, 600)},
                           {1: ("<p>b</p>", 150), 3: ("<p>d</p>", 250)})
    assert message is None, message
    assert (stats[2]["output_tokens"], stats[2]["blocks"], stats[2]["skipped"]) == (550, 2, 1), stats[2]
    assert (stats[4]["output_tokens"], stats[4]["blocks"], stats[4]["skipped"]) == (850, 1, 0), stats[4]
    assert stats[1]["output_tokens"] == 3000 and stats[3]["output_tokens"] == 3000, stats


def test_input_usage_follows_the_kept_output_attribution(guard, tmp_path):
    # Input usage follows the same kept-output attribution, not the discarded full-page requests.
    message, stats = guard({**CLEAN, 1: (LOOP, 16384), 3: (LOOP, 16384)}, {1: (MIXED, 400), 3: (LAYOUT, 600)},
                           {1: ("<p>b</p>", 150), 3: ("<p>d</p>", 250)}, input_by_request=INPUTS)
    assert message is None and [stats[n]["input_tokens"] for n in range(1, 5)] == [900, 50, 902, 100]
    report = json.loads((tmp_path / "surya-guard" / "report.json").read_text(encoding="utf-8"))
    assert report["tokens"]["input"] == 1952


def test_a_partial_input_count_is_never_presented_as_a_total(guard):
    inputs = {key: value for key, value in INPUTS.items() if key != ("block", 1)}
    message, stats = guard({**CLEAN, 1: (LOOP, 16384)}, {1: (LAYOUT, 500)}, {1: ("<p>b</p>", 200)},
                           input_by_request=inputs)
    assert message is None and stats[2]["input_tokens"] is None  # never present a partial page count as total


def test_a_rebuilt_page_whose_layout_request_failed_is_refused_as_empty(guard):
    # A rebuilt page whose layout request fails, or answers nonsense, comes back with no blocks at all: that is
    # content lost, not a blank page, and the run is refused naming it.
    message, stats = guard({**CLEAN, 1: (LOOP, 16384)}, {1: ("", 0, True)})
    assert message and re.search(r"\bpage 2 \(source page 1, region 1\) came back empty", message), message
    assert stats[2]["blocks"] == 0 and not stats[2]["capped"], stats[2]


def test_a_rebuilt_page_whose_layout_answered_nonsense_is_refused_as_empty(guard):
    message, stats = guard({**CLEAN, 1: (LOOP, 16384)}, {1: ("no layout here", 50)})
    assert message and re.search(r"\bpage 2\b.* came back empty", message) and stats[2]["blocks"] == 0, (message, stats[2])


def test_without_cuts_pages_are_numbered_within_the_range_and_the_advice_closes_the_refusal(guard):
    # Without cuts, pages are numbered within the selected range; the message keeps the source page.
    message, _ = guard({0: (html("a"), 16384)}, cut="none", pages=(1, 1))
    assert message and re.search(r"\bpage 1 \(source page 1\) stopped at its full page request", message), message
    assert message and message.endswith("(see the debug report)"), message  # the advice closes every refusal


def test_where_names_the_source_page_within_a_range():
    assert where(None, (10, 12), 2) == "page 2 (source page 11)" and where(None, None, 3) == "page 3"


# --- The server launcher and the CLI's refusals -----------------------------------------------------------------------


@pytest.mark.parametrize("flags", [["--model", "surya", "--max-image-size", "800"],
                                   ["--max-output-tokens", "0"],
                                   ["--model", "unknown"]],
                         ids=["surya-max-image-size", "zero-output-tokens", "unknown-model"])
def test_invalid_cli_flags_are_refused(flags, fake, scan_pdf, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # the default output directory is scratch/MODEL, relative to here; never reached
    flags = [flag.format(url=fake.url) for flag in flags]
    assert exit_code(str(scan_pdf), *flags) == 2, f"Invalid CLI flags accepted: {flags}"
