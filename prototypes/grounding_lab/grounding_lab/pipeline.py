"""Tiered evidence-grounding pipeline: lexical containment, then CE/NLI.

Every tier answers with an anchor (or abstention), model-native relevance, and
a legacy ambiguity margin. The margin is not calibrated confidence. Neural
models load lazily so lexical checks do not touch torch.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import cache

BI_ENCODER_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
CROSS_ENCODER_MODEL = "Qwen/Qwen3-Reranker-0.6B"
CROSS_ENCODER_REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
CROSS_ENCODER_BATCH_SIZE = 16
CROSS_ENCODER_ABSTAIN_THRESHOLD = float("-inf")
RERANK_INSTRUCTION = (
    "Judge whether the candidate passage directly supports the extracted scalar. "
    "Near-variant names, identifiers, dates, units, and numbers are not evidence."
)
NLI_MODEL = "MoritzLaurer/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7"

SHORTLIST_K = 10
NLI_ABSTAIN_THRESHOLD = 0.5


@dataclass(frozen=True)
class Anchor:
    anchor_id: str
    text: str
    page: int
    # Neural tiers score `context` (e.g. table-row text) when present; lexical
    # containment always uses raw `text` so row context can't create false hits.
    context: str | None = None
    kind: str | None = None
    after_bibliography: bool | None = None
    logical_table_id: str | None = None
    row: int | None = None
    column: int | None = None
    role: str | None = None

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
    # Historical best-minus-runner-up ambiguity margin, not a probability.
    confidence: float
    tier: str


# --- normalization -----------------------------------------------------------

# 17.06.1790 / 17/06/1790 / 17-06-1790 -> 1790-06-17 (zero-padded)
_DMY_DATE = re.compile(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b")
_ISO_DATE = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_GROUPING_SEP = re.compile(r"(?<=\d)[.,](?=\d{3}(?!\d))")
# Digit grouping by space. Documents: only typographic no-break spaces
# (U+00A0/U+202F) are joined, before NFKC folds them — a plain space between
# numbers in a table row ("page 5 200", "475 482") is two values, not one.
# A scalar claim value is one number, so there a plain space is grouping too.
_NBSP_GROUPING = re.compile(r"(?<=\d)[\u00a0\u202f](?=\d{3}(?!\d))")
_SPACE_GROUPING = re.compile(r"(?<!\d)(\d{1,3})((?: \d{3})+)(?!\d)")
# "1300m2" -> "1300 m2": extractors emit "1300 m2", documents glue the unit.
_DIGIT_LETTER = re.compile(r"(?<=\d)(?=[^\W\d_])")
_WS = re.compile(r"\s+")

# Month names (en/da/de/fr/it/es, casefolded): "13. august 2004" -> 2004-08-13
_MONTHS: dict[str, int] = {
    name: number
    for number, names in enumerate(
        [
            "january januar janvier gennaio enero jan",
            "february februar février fevrier febbraio febrero feb",
            "march marts märz maerz mars marzo mar",
            "april avril aprile abril apr",
            "may maj mai maggio mayo",
            "june juni juin giugno junio jun",
            "july juli juillet luglio julio jul",
            "august août aout agosto aug",
            "september septembre settembre septiembre sep sept",
            "october oktober octobre ottobre octubre oct okt",
            "november novembre noviembre nov",
            "december dezember décembre decembre dicembre diciembre dec dez",
        ],
        start=1,
    )
    for name in names.split()
}
_DAY_MONTHNAME_YEAR = re.compile(r"\b(\d{1,2})\.?\s+([^\W\d_]+)\.?\s+(\d{4})\b")
_MONTHNAME_DAY_YEAR = re.compile(r"\b([^\W\d_]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b")


def _named_date(day: str, month: str, year: str, original: str) -> str:
    number = _MONTHS.get(month)
    if number is None or not 1 <= int(day) <= 31:
        return original
    return f"{year}-{number:02d}-{int(day):02d}"


def _dmy_to_iso(m: re.Match) -> str:
    day, month = int(m[1]), int(m[2])
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return m[0]  # "35.06.1790" is section numbering, not a date
    return f"{m[3]}-{month:02d}-{day:02d}"


@cache
def normalize(text: str) -> str:
    out = _NBSP_GROUPING.sub("", text)
    # U+2212 minus and U+2013 en-dash both read as "-" so a range stays one token.
    out = unicodedata.normalize("NFKC", out).casefold().replace("−", "-").replace("–", "-")
    out = _DAY_MONTHNAME_YEAR.sub(lambda m: _named_date(m[1], m[2], m[3], m[0]), out)
    out = _MONTHNAME_DAY_YEAR.sub(lambda m: _named_date(m[2], m[1], m[3], m[0]), out)
    out = _DMY_DATE.sub(_dmy_to_iso, out)
    out = _ISO_DATE.sub(lambda m: f"{m[1]}-{int(m[2]):02d}-{int(m[3]):02d}", out)
    # ponytail: grouping-separator heuristic — "1.234,56" and "1,234.56" both
    # become "1234.56"; ambiguous 3-digit decimals ("1,234") read as grouping.
    out = _GROUPING_SEP.sub("", out)
    out = re.sub(r"(?<=\d),(?=\d)", ".", out)
    # Keep semantic numeric markers. Dropping them makes "$50" and "50%"
    # indistinguishable and turns a wrong lexical link into confidence 1.0.
    out = "".join(
        ch
        if ch.isalnum()
        or ch.isspace()
        or ch in "_.-%"
        or unicodedata.category(ch) == "Sc"
        else " "
        for ch in out
    )
    out = _WS.sub(" ", out)
    out = re.sub(r"\s+%", "%", out)
    out = re.sub(
        r"(\S)\s+(?=\d)",
        lambda m: m[1] if unicodedata.category(m[1]) == "Sc" else m[0],
        out,
    )
    # A currency symbol after a number glues to it ("50 €") unless it starts
    # the next number: "in 2024 ($116,800)" must not become "2024$116800".
    out = re.sub(
        r"(?<=\d)\s+(\S)(?!\d)",
        lambda m: m[1] if unicodedata.category(m[1]) == "Sc" else m[0],
        out,
    )
    out = _DIGIT_LETTER.sub(" ", out)
    return out.strip()


def _join_space_groups(scalar: str) -> str:
    return _SPACE_GROUPING.sub(lambda m: m[1] + m[2].replace(" ", ""), scalar)


@cache
def _join_document_space_groups(text: str) -> str:
    def join(m: re.Match) -> str:
        digits = m[1] + m[2].replace(" ", "")
        outside = (text[:m.start()] + text[m.end():]).strip()
        isolated_cell = all(
            ch in "-%" or unicodedata.category(ch) == "Sc" for ch in outside
        )
        # ponytail: ambiguous four-digit groups join only in an isolated table
        # cell; "page 5 200" remains two adjacent values.
        return digits if len(digits) >= 5 or isolated_cell else m[0]

    return _SPACE_GROUPING.sub(join, text)


def bounded_contains(value: str | int | float | bool, text: str) -> bool:
    """Whether a scalar appears as a normalized bounded token."""
    needle = normalize(str(value))
    haystack = normalize(text)
    if not needle:
        return False
    if len(needle) == 1 and not needle.isdigit():
        return haystack == needle  # safe for one-character table cells
    # Match whole tokens, including numeric signs, decimals and ranges.
    patterns = []
    for n in {needle, _join_space_groups(needle)}:
        numeric_start = r"(?<![.-])" if n[0].isdigit() else ""
        numeric_end = r"(?!\.\d)" if n[-1].isdigit() else ""
        patterns.append(rf"(?<!\w)(?<!\d-){numeric_start}{re.escape(n)}(?!\w)(?!-\d){numeric_end}")
    return any(
        re.search(pattern, candidate)
        for pattern in patterns
        for candidate in {haystack, _join_document_space_groups(haystack)}
    )


def loose_contains(value: str | int | float | bool, text: str) -> bool:
    """Whitespace-tolerant containment for OCR/PDF spacing: "Im Dol 2 -6",
    "Jos é", "AAR 33284" for the claim "AAR33284". Never a lexical link —
    hits reach the scorer as non-verbatim candidates, so they are capped and
    reviewed. Optional whitespace is allowed between characters but never
    inside a digit run, so "grav 12" cannot match "grav 1 2"."""
    needle = normalize(str(value)).replace(" ", "")
    if len(needle) < 4 or not any(ch.isalpha() for ch in needle):
        return False
    pattern = "".join(
        re.escape(ch) + ("" if ch.isdigit() and needle[i + 1].isdigit() else r"\s?")
        for i, ch in enumerate(needle[:-1])
    ) + re.escape(needle[-1])
    return re.search(rf"(?<!\w){pattern}(?!\w)", normalize(text)) is not None


def claim_field(claim: Claim) -> str:
    """Last named segment of the result path ("records", 2, "lab") -> "lab"."""
    return next(
        (seg for seg in reversed(claim.result_path) if isinstance(seg, str)),
        "value",
    )


def render_claim(claim: Claim, siblings: bool = True) -> str:
    """field name + value, plus sibling context unless siblings=False."""
    field = claim_field(claim)
    # snake_case and camelCase both become words: "medianIncome2024" ->
    # "median Income 2024" so a reranker sees the year, not one opaque token.
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=\d)", " ", field.replace("_", " "))
    rendered = f"{words}: {claim.value}"
    if siblings and claim.context:
        return f"{rendered} ({claim.context})"
    return rendered


# --- tier 1: lexical ---------------------------------------------------------

def lexical_candidates(claim: Claim, anchors: list[Anchor]) -> list[Anchor]:
    """Every anchor containing the value as a bounded token.

    Two or more hits mean the value is verbatim in the document and the gold
    is one of them: disambiguate inside this set instead of re-retrieving.
    """
    # Word-boundary containment: "18" must not match inside "1834". \w bounds
    # cover digits and letters; hyphens/dots are non-word so "8-1" still works.
    return [a for a in anchors if bounded_contains(claim.value, a.text)]


def lexical_tier(claim: Claim, anchors: list[Anchor]) -> tuple[Link | None, list[Anchor]]:
    """One anchor scan -> (decision, hits). One hit links; several hits return
    decision None and the hit set for a scorer to disambiguate. Zero strict
    hits fall back to whitespace-tolerant hits (OCR/PDF spacing), which are
    also undecided but never verbatim, so the scorer's containment cap keeps
    them out of auto-accept; no hits at all abstain (absent or paraphrased).
    Shared by ground(), calibrate and the model benchmark so the policy lives
    in one place."""
    hits = lexical_candidates(claim, anchors)
    if len(hits) == 1:
        return Link(hits[0].anchor_id, 1.0, 1.0, "lexical"), hits
    if not hits:
        hits = [a for a in anchors if loose_contains(claim.value, a.text)]
        if not hits:
            return Link(None, 0.0, 0.0, "lexical"), hits
    return None, hits


def lexical_match(claim: Claim, anchors: list[Anchor]) -> Link | None:
    link, _ = lexical_tier(claim, anchors)
    return link if link is not None and link.anchor_id else None


def index_anchors(anchors: list[Anchor]) -> None:
    """Normalize every anchor once per document. `normalize` and the document
    space-group join are cached, so this is the one-off cost a grounder pays
    when a document is parsed; the per-claim scan then only runs the searches."""
    for anchor in anchors:
        _join_document_space_groups(normalize(anchor.text))


# --- tier 1b: sibling gate ---------------------------------------------------

SIBLING_WINDOW = 3
SIBLING_MIN_CHARS = 3
_BARE_NUMBER = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def bare_number(value: str | int | float | bool) -> bool:
    """Short unit-less numbers ("6", "0.95", "1970") occur dozens of times in
    a catalogue; their hit sets need a sibling match before any link."""
    text = str(value)
    return len(text) <= 4 and _BARE_NUMBER.fullmatch(text) is not None


def letter_suffix_ambiguous(
    value: str | int | float | bool, anchors: list[Anchor]
) -> bool:
    """Whether a numeric value also occurs as a letter-suffixed identifier."""
    needle = normalize(str(value))
    if not needle.isdigit():
        return False
    pattern = re.compile(rf"(?<!\w){re.escape(needle)}[^\W\d_](?!\w)")
    return any(
        pattern.search(unicodedata.normalize("NFKC", anchor.text).casefold())
        for anchor in anchors
    )


def sibling_values(claim: Claim) -> list[str]:
    """Sibling values from "field: value, field: value" (a value may itself
    hold ", "). Values under SIBLING_MIN_CHARS normalized characters ("2")
    match everywhere and are dropped."""
    values: list[str] = []
    for fragment in (claim.context or "").split(", "):
        if ": " in fragment:
            values.append(fragment.split(": ", 1)[1])
        elif values:
            values[-1] += ", " + fragment
    return [v for v in values if len(normalize(v)) >= SIBLING_MIN_CHARS]


def sibling_support(
    claim: Claim, position: int, anchors: list[Anchor], window: int = SIBLING_WINDOW
) -> bool:
    """Whether a sibling value of the claim appears in the anchor at
    `position`, its table row (`context`) or a same-page anchor within
    `window` places in reading order."""
    anchor = anchors[position]
    texts = [anchor.text, anchor.context or ""] + [
        a.text
        for a in anchors[max(0, position - window): position + window + 1]
        if a.page == anchor.page
    ]
    return any(bounded_contains(s, t) for s in sibling_values(claim) for t in texts)


def row_sibling_coverage(claim: Claim, anchor: Anchor) -> int:
    """Count claim siblings found in the candidate's own cell/row context."""
    text = anchor.scoring_text
    return sum(bounded_contains(value, text) for value in sibling_values(claim))


def narrow_row_hits(claim: Claim, hits: list[Anchor]) -> list[Anchor]:
    """Keep exact-value cells whose own table row contains a claim sibling.

    Empty pruning falls back to the complete hit set. The scorer still sees a
    pruned singleton: this helper narrows candidates but never accepts a link.
    """
    if len(hits) < 2:
        return hits
    value = normalize(str(claim.value))
    kept = [
        anchor for anchor in hits
        if anchor.context is not None
        and normalize(anchor.text) == value
        and row_sibling_coverage(claim, anchor) > 0
    ]
    return kept or hits


def narrow_bare_number_hits(claim: Claim, hits: list[Anchor]) -> list[Anchor]:
    return narrow_row_hits(claim, hits) if bare_number(claim.value) else hits


def gated_lexical_tier(
    claim: Claim, anchors: list[Anchor], window: int = SIBLING_WINDOW
) -> tuple[Link | None, list[Anchor]]:
    """lexical_tier, then the sibling gate. One strict hit whose neighbourhood
    holds no sibling value keeps its anchor at confidence 0.0 (review, never
    auto-accepted). A bare number with several hits is narrowed to the
    sibling-supported anchors: none abstains, one links, several go to the
    scorer. Claims without a usable sibling pass through unchanged: the field
    cannot be verified, and that is reported, not hidden."""
    decided, hits = lexical_tier(claim, anchors)
    if not sibling_values(claim):
        return decided, hits
    position = {a.anchor_id: i for i, a in enumerate(anchors)}
    if decided is not None and decided.anchor_id:
        if sibling_support(claim, position[hits[0].anchor_id], anchors, window):
            return decided, hits
        return Link(decided.anchor_id, 1.0, 0.0, "lexical-gated"), hits
    if decided is None and bare_number(claim.value):
        kept = [a for a in hits if sibling_support(claim, position[a.anchor_id], anchors, window)]
        if not kept:
            return Link(None, 0.0, 0.0, "lexical-gated"), []
        if len(kept) == 1:
            return Link(kept[0].anchor_id, 1.0, 1.0, "lexical-gated"), kept
        return None, kept
    return decided, hits


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
    import torch

    return CrossEncoder(
        CROSS_ENCODER_MODEL,
        revision=CROSS_ENCODER_REVISION,
        prompts={"evidence": RERANK_INSTRUCTION},
        default_prompt_name="evidence",
        model_kwargs={"dtype": torch.bfloat16},
    )


def _margin_link(
    scores,
    shortlist: list[Anchor],
    tier: str,
    abstain_threshold: float = NLI_ABSTAIN_THRESHOLD,
) -> Link:
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
    if best < abstain_threshold:
        return Link(None, best, confidence, tier)
    return Link(shortlist[int(order[0])].anchor_id, best, confidence, tier)


def cross_encoder_match(claim_text: str, shortlist: list[Anchor]) -> Link:
    scores = _cross_encoder().predict(
        [(claim_text, a.scoring_text) for a in shortlist],
        batch_size=CROSS_ENCODER_BATCH_SIZE,
        show_progress_bar=False,
    )
    return _margin_link(
        scores,
        shortlist,
        "cross-encoder",
        CROSS_ENCODER_ABSTAIN_THRESHOLD,
    )


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
    if link.anchor_id is None:
        return link
    anchor = next(a for a in shortlist if a.anchor_id == link.anchor_id)
    if bounded_contains(claim.value, anchor.text):
        return link
    return Link(link.anchor_id, link.score, min(link.confidence, 0.25), link.tier + "*")


# --- pipeline configs --------------------------------------------------------

def ground(claim: Claim, index: AnchorIndex, config: str) -> Link:
    """config: CONFIGS below.

    lexical* configs scan the anchors once: one hit links, zero hits abstain
    (absent or paraphrased — no neural pass), several hits are disambiguated
    by the scorer inside that hit set. There the claim is rendered as
    "field name: value (siblings)" — abstention is not at stake inside a
    verbatim hit set, and siblings are what pick a table row over prose
    mentions of the same value — or as the bare value for "-bare" configs,
    matching what the production GroundingModelRequest carries today.
    ce-only / nli-only skip tier 1 entirely: dense shortlist, rich claim.
    """
    if config not in CONFIGS:
        raise ValueError(f"unknown config: {config!r}")
    if config.startswith("lexical"):
        decided, hits = lexical_tier(claim, index.anchors)
        if decided is not None:
            return decided
        if config == "lexical":
            return Link(None, 0.0, 0.0, "lexical")
        shortlist = hits
        claim_text = (
            str(claim.value) if config.endswith("-bare")
            else render_claim(claim)
        )
    else:
        claim_text = render_claim(claim)
        shortlist = index.shortlist(claim_text)
    scorer = nli_match if "nli" in config else cross_encoder_match
    return verbatim_downgrade(scorer(claim_text, shortlist), claim, shortlist)


CONFIGS = [
    "lexical",
    "lexical+ce",
    "lexical+nli",
    "lexical+ce-bare",
    "lexical+nli-bare",
    "ce-only",
    "nli-only",
]
