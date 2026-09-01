"""Tiered evidence-grounding pipeline: lexical -> bi-encoder shortlist -> CE/NLI.

Every tier answers (anchor_id | None, score in [0, 1]); None means abstain and
fall through to the next tier. Neural models load lazily so the lexical tier
and its tests never touch torch.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import cache

BI_ENCODER_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
CROSS_ENCODER_MODEL = "BAAI/bge-reranker-v2-m3"
NLI_MODEL = "MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7"

SHORTLIST_K = 10
ABSTAIN_THRESHOLD = 0.5


@dataclass(frozen=True)
class Anchor:
    anchor_id: str
    text: str
    page: int
    # Neural tiers score `context` (e.g. table-row text) when present; lexical
    # containment always uses raw `text` so row context can't create false hits.
    context: str | None = None

    @property
    def scoring_text(self) -> str:
        return self.context or self.text


@dataclass(frozen=True)
class Claim:
    value: str | int | float | bool
    result_path: tuple[str | int, ...]
    # Empty tuple = the value is not in the document (correct answer: abstain).
    gold_anchor_ids: tuple[str, ...]
    # Sibling extraction values ("port: Livorno, region: Med") — in production
    # these come from the extraction result; here they are authored per claim.
    context: str | None = None


@dataclass(frozen=True)
class Link:
    anchor_id: str | None
    # Absolute relevance of the best candidate — the link/abstain gate.
    score: float
    # best minus runner-up: the reviewer-facing confidence. Near-zero means
    # the pick was a coin toss even when `score` is high.
    confidence: float
    tier: str


# --- normalization -----------------------------------------------------------

# 17.06.1790 / 17/06/1790 / 17-06-1790 -> 1790-06-17 (zero-padded)
_DMY_DATE = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b")
_ISO_DATE = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_GROUPING_SEP = re.compile(r"(?<=\d)[.,](?=\d{3}\b)")
_PUNCT = re.compile(r"[^\w\s.-]", re.UNICODE)
_WS = re.compile(r"\s+")


def _dmy_to_iso(m: re.Match) -> str:
    day, month = int(m[1]), int(m[2])
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return m[0]  # "35.06.1790" is section numbering, not a date
    return f"{m[3]}-{month:02d}-{day:02d}"


def normalize(text: str) -> str:
    out = unicodedata.normalize("NFKC", text).casefold()
    out = _DMY_DATE.sub(_dmy_to_iso, out)
    out = _ISO_DATE.sub(lambda m: f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}", out)
    # ponytail: grouping-separator heuristic — "1.234,56" and "1,234.56" both
    # become "1234.56"; ambiguous 3-digit decimals ("1,234") read as grouping.
    out = _GROUPING_SEP.sub("", out)
    out = re.sub(r"(?<=\d),(?=\d)", ".", out)
    out = _PUNCT.sub(" ", out)
    return _WS.sub(" ", out).strip()


def bounded_contains(value: str | int | float | bool, text: str) -> bool:
    """Whether a non-boolean scalar appears as a normalized bounded token."""
    if isinstance(value, bool):
        return False
    needle = normalize(str(value))
    return len(needle) >= 2 and bool(
        re.search(rf"(?<!\w){re.escape(needle)}(?!\w)", normalize(text))
    )


def render_claim(claim: Claim) -> str:
    field = next(
        (seg for seg in reversed(claim.result_path) if isinstance(seg, str)),
        "value",
    )
    rendered = f"{field.replace('_', ' ')}: {claim.value}"
    return f"{rendered} ({claim.context})" if claim.context else rendered


# --- tier 1: lexical ---------------------------------------------------------

def lexical_match(claim: Claim, anchors: list[Anchor]) -> Link | None:
    # Word-boundary containment: "18" must not match inside "1834". \w bounds
    # cover digits and letters; hyphens/dots are non-word so "8-1" still works.
    containing = [a for a in anchors if bounded_contains(claim.value, a.text)]
    if len(containing) == 1:
        return Link(containing[0].anchor_id, 1.0, 1.0, "lexical")
    return None  # absent or ambiguous — let a scoring tier decide


# --- tier 2: bi-encoder shortlist -------------------------------------------

@cache
def _bi_encoder():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(BI_ENCODER_MODEL)


class AnchorIndex:
    """Per-document anchor embeddings, computed once."""

    def __init__(self, anchors: list[Anchor]):
        self.anchors = anchors
        self._embeddings = None

    def shortlist(self, claim_text: str, k: int = SHORTLIST_K) -> list[Anchor]:
        model = _bi_encoder()
        if self._embeddings is None:
            self._embeddings = model.encode(
                [a.scoring_text for a in self.anchors], normalize_embeddings=True
            )
        query = model.encode([claim_text], normalize_embeddings=True)[0]
        similarities = self._embeddings @ query
        order = similarities.argsort()[::-1][:k]
        return [self.anchors[i] for i in order]


# --- tier 3a: cross-encoder rerank ------------------------------------------

@cache
def _cross_encoder():
    from sentence_transformers import CrossEncoder

    return CrossEncoder(CROSS_ENCODER_MODEL)


def _margin_link(scores, shortlist: list[Anchor], tier: str) -> Link:
    """Gate on absolute best score; confidence = best minus runner-up.

    Both quantities are kept and reported separately: `score` says "is this
    anchor relevant at all", `confidence` says "was the pick contested". A
    wrong link in an ambiguous field can still score 0.99, but its margin
    collapses — that is what routes it to review.
    """
    if len(shortlist) == 0:
        return Link(None, 0.0, 0.0, tier)
    order = scores.argsort()[::-1]
    best = float(scores[order[0]])
    runner_up = float(scores[order[1]]) if len(order) > 1 else 0.0
    confidence = min(1.0, max(0.0, best - runner_up))
    if best < ABSTAIN_THRESHOLD:
        return Link(None, best, confidence, tier)
    return Link(shortlist[int(order[0])].anchor_id, best, confidence, tier)


def cross_encoder_match(claim_text: str, shortlist: list[Anchor]) -> Link:
    scores = _cross_encoder().predict(
        [(claim_text, a.scoring_text) for a in shortlist]
    )
    return _margin_link(scores, shortlist, "cross-encoder")


# --- tier 3b: NLI entailment -------------------------------------------------

@cache
def _nli():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(NLI_MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(NLI_MODEL)
    if torch.cuda.is_available():
        model = model.cuda()
    model.eval()
    entailment_index = next(
        i for i, label in model.config.id2label.items()
        if label.lower().startswith("entail")
    )
    return torch, tokenizer, model, entailment_index


def nli_match(claim_text: str, shortlist: list[Anchor]) -> Link:
    torch, tokenizer, model, entailment_index = _nli()
    inputs = tokenizer(
        [a.scoring_text for a in shortlist],
        [claim_text] * len(shortlist),
        truncation=True,
        padding=True,
        return_tensors="pt",
    ).to(model.device)
    with torch.no_grad():
        probabilities = model(**inputs).logits.softmax(dim=-1)
    entailment = probabilities[:, entailment_index].cpu().numpy()
    return _margin_link(entailment, shortlist, "nli")


# --- verbatim containment post-check -----------------------------------------

def verbatim_downgrade(link: Link, claim: Claim, shortlist: list[Anchor]) -> Link:
    """Cap confidence when the claim value is not verbatim in the picked anchor.

    Targets near-variant hallucinations ("TAK 1507" linking the TAK 1506
    anchor with a huge margin): a neural pick whose anchor does not contain
    the value as a bounded token is routed to review, never auto-accepted.
    Downgrade only — paraphrased values (ISO date vs month name) legitimately
    fail containment while still being correct links.

    Checks raw `text`, not `scoring_text`: row context would let a wrong
    sibling cell pass whenever the value appears anywhere in its table row.
    """
    if link.anchor_id is None or isinstance(claim.value, bool):
        return link
    anchor = next(a for a in shortlist if a.anchor_id == link.anchor_id)
    if bounded_contains(claim.value, anchor.text):
        return link
    return Link(link.anchor_id, link.score, min(link.confidence, 0.25), link.tier + "*")


# --- pipeline configs --------------------------------------------------------

def ground(claim: Claim, index: AnchorIndex, config: str) -> Link:
    """config: CONFIGS below. "-bare" renders the claim as the bare value only,
    matching what the production GroundingModelRequest can carry today."""
    if config not in CONFIGS:
        raise ValueError(f"unknown config: {config!r}")
    if config.startswith("lexical"):
        link = lexical_match(claim, index.anchors)
        if link is not None:
            return link
        if config == "lexical":
            return Link(None, 0.0, 0.0, "lexical")
    claim_text = (
        str(claim.value) if config.endswith("-bare") else render_claim(claim)
    )
    shortlist = index.shortlist(claim_text)
    if "nli" in config:
        link = nli_match(claim_text, shortlist)
    else:
        link = cross_encoder_match(claim_text, shortlist)
    return verbatim_downgrade(link, claim, shortlist)


CONFIGS = [
    "lexical",
    "lexical+ce",
    "lexical+nli",
    "lexical+ce-bare",
    "lexical+nli-bare",
    "ce-only",
    "nli-only",
]
