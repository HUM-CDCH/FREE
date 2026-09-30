"""Confidence: fusion of signals, calibration, risk-coverage evaluation and risk control.

What each score estimates. A fused or calibrated score is an estimate of P(target = 1) for one predicted value field,
where the target is `value` (the value equals the gold value) or `supported` (the value is right and its citation is the
gold span; defined only where gold evidence is annotated). They are separate targets with separate models; nothing here
multiplies them. Missing signals are never zero-filled: each signal that is ever missing gets an indicator feature and is
imputed with the fit split's mean.

Splits. The fusion is fit on split `fit` only; calibrators and risk-control thresholds use `calibration`; reports use
`dev`; `test` is read only by an explicit final step. Risk control operates on the fused score itself (a fixed
function of the fit split), never on a calibrated score fit on the same calibration labels.

Risk control (formal guarantees, from the papers, for exchangeable units). The unit is the document group, never the
field: fields of one document are dependent, and a document family shares its source. A guarantee needs a fixed grid and
order chosen before the calibration labels are seen (here thresholds 1.0 down to 0.0 on a fixed grid), a bounded loss per
unit, and calibration units exchangeable with deployment units. With too few units the guarantee is reported unavailable,
never approximated. Micro (pooled accepted-field) risk and macro (per-group mean) risk differ and are both reported.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import optimize, special, stats

from experiments.harness.signals import SIGNALS

BASELINE = ("verbalized", "p_first", "p_mean", "margin", "agreement", "view_agreement", "align", "verdict", "ocr")
INVERTED = ("conflict", "invalid")          # 1 means trouble: the baseline uses 1 - signal


# --- outcome tables -----------------------------------------------------------------------------------------------------

def table(outcomes: list[dict], target: str = "value") -> list[dict]:
    """Rows {doc, group, split, y, signals} for the predicted values whose correctness is defined under `target`."""
    rows = []
    for o in outcomes:
        y = o["correct"] if target == "value" else o["supported"]
        if y is None:
            continue
        rows.append({"doc": o["doc"], "group": o["group"], "split": o["split"], "y": int(bool(y)), "signals": o["row"]["signals"]})
    return rows


# --- deterministic baseline and learned fusion ---------------------------------------------------------------------------

def rank_score(signals: dict) -> float | None:
    """The unweighted mean of the direction-corrected signals a row has, each in [0, 1]; None when it has none. A missing
    signal is left out, not counted as zero. No fitting: a deterministic ranking baseline."""
    values = [1 - signals[name] if name in INVERTED else signals[name] for name in (*BASELINE, *INVERTED) if signals.get(name) is not None]
    return sum(values) / len(values) if values else None


def _sigmoid(z):
    return special.expit(z)


def _logistic(x: np.ndarray, y: np.ndarray, l2: float) -> np.ndarray:
    """Weights (bias last) of an L2-regularised logistic regression by L-BFGS; the bias is not penalised."""
    n, d = x.shape
    a = np.hstack([x, np.ones((n, 1))])

    def loss(w):
        z = a @ w
        value = np.mean(np.logaddexp(0, z) - y * z) + l2 * float(w[:-1] @ w[:-1]) / (2 * n)
        grad = a.T @ (_sigmoid(z) - y) / n
        grad[:-1] += l2 * w[:-1] / n
        return value, grad
    return optimize.minimize(loss, np.zeros(d + 1), jac=True, method="L-BFGS-B").x


@dataclass
class Fusion:
    names: list[str]
    fill: dict[str, float]              # fit-split mean, used for a missing value (with its indicator)
    indicators: list[str]               # signals that were ever missing in the fit split
    mean: np.ndarray
    scale: np.ndarray
    weights: np.ndarray                 # bias last

    def _x(self, rows: list[dict]) -> np.ndarray:
        cols = [[(r.get(n) if r.get(n) is not None else self.fill[n]) for r in rows] for n in self.names]
        cols += [[float(r.get(n) is None) for r in rows] for n in self.indicators]
        x = np.array(cols, dtype=float).T if cols else np.zeros((len(rows), 0))
        return (x - self.mean) / self.scale

    def dump(self) -> dict:
        return {"names": self.names, "fill": self.fill, "indicators": self.indicators, "mean": self.mean.tolist(),
                "scale": self.scale.tolist(), "weights": self.weights.tolist()}

    def score(self, rows: list[dict]) -> np.ndarray:
        """P(target) for each signals dict; a fusion fit on one class returns that class's rate."""
        if not len(rows):
            return np.array([])
        return _sigmoid(np.hstack([self._x(rows), np.ones((len(rows), 1))]) @ self.weights)


def fit_fusion(rows: list[dict], l2: float = 1.0, names: tuple[str, ...] = SIGNALS) -> Fusion:
    """Fit on the given rows, which must all be from split `fit`: a leak of any other split is refused."""
    if {r["split"] for r in rows} - {"fit"}:
        raise ValueError("fusion is fit on split 'fit' only; calibration, dev and test labels never enter it")
    if not rows:
        raise ValueError("no rows to fit")
    signals = [r["signals"] for r in rows]
    used = [n for n in names if any(s.get(n) is not None for s in signals)]
    fill = {n: float(np.mean([s[n] for s in signals if s.get(n) is not None])) for n in used}
    indicators = [n for n in used if any(s.get(n) is None for s in signals)]
    shell = Fusion(used, fill, indicators, np.zeros(len(used) + len(indicators)), np.ones(len(used) + len(indicators)), np.zeros(1))
    x = shell._x(signals)
    y = np.array([r["y"] for r in rows], dtype=float)
    mean, scale = x.mean(0), x.std(0)
    scale[scale == 0] = 1.0
    z = (x - mean) / scale
    if y.min() == y.max():   # one class: the rate itself, no signal can be learned
        bias = special.logit(np.clip(y.mean(), 1e-6, 1 - 1e-6))
        weights = np.append(np.zeros(z.shape[1]), bias)
    else:
        weights = _logistic(z, y, l2)
    return Fusion(used, fill, indicators, mean, scale, weights)


class Platt:
    """Logistic calibration of a score in (0, 1): a monotone map, fit on split `calibration` only."""

    def fit(self, scores: np.ndarray, y: np.ndarray) -> Platt:
        z = special.logit(np.clip(scores, 1e-6, 1 - 1e-6))[:, None]
        self.mean, self.scale = z.mean(), (z.std() or 1.0)
        self.w = _logistic((z - self.mean) / self.scale, y.astype(float), 1e-6) if y.min() != y.max() else \
            np.array([0.0, special.logit(np.clip(y.mean(), 1e-6, 1 - 1e-6))])
        return self

    def predict(self, scores: np.ndarray) -> np.ndarray:
        z = (special.logit(np.clip(scores, 1e-6, 1 - 1e-6)) - self.mean) / self.scale
        return _sigmoid(self.w[0] * z + self.w[1])

    def dump(self) -> dict:
        return {"mean": float(self.mean), "scale": float(self.scale), "weights": self.w.tolist()}


class Isotonic:
    """Isotonic calibration (scipy's pool-adjacent-violators): non-decreasing in the score, piecewise-constant, with ties
    in the score averaged first."""

    def fit(self, scores: np.ndarray, y: np.ndarray) -> Isotonic:
        order = np.argsort(scores, kind="stable")
        xs, ys = scores[order], y[order].astype(float)
        unique, inverse = np.unique(xs, return_inverse=True)
        weights = np.bincount(inverse)
        means = np.bincount(inverse, weights=ys) / weights
        self.x, self.y = unique, optimize.isotonic_regression(means, weights=weights.astype(float), increasing=True).x
        return self

    def predict(self, scores: np.ndarray) -> np.ndarray:
        return np.interp(scores, self.x, self.y)

    def dump(self) -> dict:
        return {"x": self.x.tolist(), "y": self.y.tolist()}


# --- evaluation ---------------------------------------------------------------------------------------------------------

def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    """Expected calibration error over equal-width bins of the score."""
    index = np.minimum((p * bins).astype(int), bins - 1)
    return float(sum(abs(p[index == b].mean() - y[index == b].mean()) * (index == b).sum() for b in range(bins) if (index == b).any()) / len(p))


def auroc(p: np.ndarray, y: np.ndarray) -> float | None:
    """P(a random correct value scores above a random wrong one), ties half: how well the score ranks errors last."""
    positives, negatives = (y == 1).sum(), (y == 0).sum()
    if not positives or not negatives:
        return None
    ranks = stats.rankdata(p)
    return float((ranks[y == 1].sum() - positives * (positives + 1) / 2) / (positives * negatives))


def risk_coverage(p: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Coverage and accepted-error rate at every threshold that can be applied: values with equal scores are accepted
    together, so the curve has one point per distinct score (the last row of each tie block), never a prefix that splits a
    tie according to row order."""
    order = np.argsort(-p, kind="stable")
    ps, errors = p[order], np.cumsum(1 - y[order])
    k = np.arange(1, len(p) + 1)
    ends = np.append(ps[1:] != ps[:-1], True)
    return k[ends] / len(p), errors[ends] / k[ends]


def aurc(p: np.ndarray, y: np.ndarray) -> float:
    """Area under the step curve of accepted-error rate against coverage."""
    coverage, risk = risk_coverage(p, y)
    return float(np.sum(risk * np.diff(np.concatenate([[0.0], coverage]))))


def coverage_at_risk(p: np.ndarray, y: np.ndarray, alpha: float) -> float:
    """The largest coverage whose empirical accepted-error rate is at most alpha (0 if none). Empirical, not a guarantee."""
    coverage, risk = risk_coverage(p, y)
    ok = coverage[risk <= alpha]
    return float(ok.max()) if len(ok) else 0.0


def errors_captured(p: np.ndarray, y: np.ndarray, budget: float) -> float | None:
    """The share of all errors inside the lowest-scored `budget` fraction of values (a review budget). Values that tie at
    the cut are reviewed at random, in expectation, so the answer does not depend on row order."""
    if not 0 <= budget <= 1:
        raise ValueError("a review budget is a fraction of the values, between 0 and 1")
    errors = int((y == 0).sum())
    if not errors:
        return None
    k = int(math.ceil(budget * len(p)))
    if k == 0:
        return 0.0                                  # nothing reviewed, no error captured
    cut = np.sort(p)[k - 1]
    below, tied = p < cut, p == cut
    return float(((y[below] == 0).sum() + (k - below.sum()) * (y[tied] == 0).mean()) / errors)


def at_threshold(p: np.ndarray, y: np.ndarray, tau: float) -> dict:
    accepted = p >= tau
    n_acc = int(accepted.sum())
    return {"threshold": tau, "accepted": n_acc, "automation_coverage": n_acc / len(p) if len(p) else None,
            "accepted_error_rate": float((y[accepted] == 0).mean()) if n_acc else None,
            "accepted_accuracy": float((y[accepted] == 1).mean()) if n_acc else None}


def check_filter_invariant(p: np.ndarray, y: np.ndarray) -> list[str]:
    """accepted_fraction x accepted_accuracy <= original accuracy at every threshold, else a denominator is inconsistent."""
    original = float((y == 1).mean())
    return [f"threshold {t}: {info['automation_coverage'] * info['accepted_accuracy']} > {original}"
            for t in np.unique(p) for info in [at_threshold(p, y, t)]
            if info["accepted"] and info["automation_coverage"] * info["accepted_accuracy"] > original + 1e-12]


def group_interval(rows: list[dict], p: np.ndarray, metric, *, draws: int = 1000, seed: int = 20260930) -> dict:
    """A percentile interval of `metric(scores, correct)` resampling whole groups: fields of one document, and documents of
    one source, are not independent observations. Not defined with fewer than two groups."""
    by_group: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_group[r["group"]].append(i)
    names = sorted(by_group)
    y = np.array([r["y"] for r in rows])
    point = metric(p, y)
    if len(names) < 2:
        return {"point": point, "interval": None, "groups": len(names), "note": "fewer than two groups"}
    rng = np.random.default_rng(seed)
    samples = []
    for _ in range(draws):
        idx = np.concatenate([by_group[names[k]] for k in rng.integers(0, len(names), len(names))])
        value = metric(p[idx], y[idx])
        if value is not None:
            samples.append(value)
    return {"point": point, "interval": [float(v) for v in np.percentile(samples, [2.5, 97.5])] if samples else None, "groups": len(names),
            "draws": draws, "used_draws": len(samples), "unit": "group"}


def evaluate(p: np.ndarray, y: np.ndarray, *, alphas=(0.05, 0.1), budgets=(0.1, 0.2)) -> dict[str, Any]:
    return {"n": len(p), "error_rate": float((y == 0).mean()) if len(p) else None, "brier": brier(p, y) if len(p) else None,
            "ece": ece(p, y) if len(p) else None, "auroc": auroc(p, y) if len(p) else None, "aurc": aurc(p, y) if len(p) else None,
            "coverage_at_empirical_risk": {str(a): coverage_at_risk(p, y, a) for a in alphas} if len(p) else {},
            "errors_captured_at_review_budget": {str(b): errors_captured(p, y, b) for b in budgets} if len(p) else {}}


# --- risk control --------------------------------------------------------------------------------------------------------

def conformal_quantile(scores: np.ndarray, alpha: float) -> float:
    """The ceil((n+1)(1-alpha))-th smallest nonconformity score, or +inf when that exceeds n (a set holding every label)."""
    n = len(scores)
    k = math.ceil((n + 1) * (1 - alpha))
    return float("inf") if k > n else float(np.sort(scores)[k - 1])


def conformal_set(probabilities: dict[str, float], qhat: float) -> list[str]:
    """Labels whose nonconformity 1 - p is at most qhat (inclusive)."""
    return [label for label, p in probabilities.items() if 1 - p <= qhat]


def split_conformal(calibration: list[tuple[str, dict[str, float], str]], alpha: float) -> dict:
    """Split conformal prediction for a closed-label field, one (unit, label probabilities, true label) per DOCUMENT. The
    guarantee, P(true label in set) >= 1 - alpha over the calibration draw and a new exchangeable document, needs one
    observation per unit: repeated units (several fields of one document) are dependent and refused."""
    units = [u for u, _, _ in calibration]
    if len(set(units)) != len(units):
        raise ValueError("split conformal needs one observation per unit; fields of one document are dependent")
    scores = np.array([1 - probabilities.get(true, 0.0) for _, probabilities, true in calibration])
    return {"unit": "document", "alpha": alpha, "n": len(scores), "qhat": conformal_quantile(scores, alpha),
            "guarantee": "P(true label in set) >= 1 - alpha, marginal over calibration and test draws, exchangeable documents",
            "upper_bound_note": "coverage is at most 1 - alpha + 1/(n+1) when scores have no ties"}


def hb_pvalue(risk_hat: float, n: int, alpha: float) -> float:
    """Hoeffding-Bentkus p-value for the null 'risk > alpha' given the empirical risk of n units with losses in [0, 1]:
    min(exp(-n h1(min(rhat, alpha), alpha)), e * P(Bin(n, alpha) <= ceil(n rhat)), 1), h1 the binary KL divergence."""
    a = min(risk_hat, alpha)
    h1 = float(special.rel_entr(a, alpha) + special.rel_entr(1 - a, 1 - alpha))
    bentkus = math.e * float(stats.binom.cdf(math.ceil(n * risk_hat - 1e-12), n, alpha))
    return min(math.exp(-n * h1), bentkus, 1.0)


def ltt_fixed_sequence(losses: np.ndarray, alpha: float, delta: float) -> dict:
    """Learn-then-Test with fixed-sequence testing. `losses[i, j]` is unit i's loss in [0, 1] at grid point j, the columns
    ordered a priori from the most conservative rule to the least. Tests each in order and stops at the first that is not
    rejected; the certified points are simultaneously safe: P(sup R(lambda) <= alpha over them) >= 1 - delta."""
    n = losses.shape[0]
    accepted, pvalues = [], []
    for j in range(losses.shape[1]):
        p = hb_pvalue(float(losses[:, j].mean()), n, alpha)
        pvalues.append(p)
        if p > delta:
            break
        accepted.append(j)
    return {"accepted": accepted, "pvalues": pvalues}


def crc_index(losses: np.ndarray, alpha: float, bound: float = 1.0) -> int | None:
    """Conformal risk control over `losses[i, j]`, columns ordered from the LEAST to the MOST conservative rule; every
    unit's loss must be non-increasing along the columns, bounded by `bound`, and the last column's loss at most alpha.
    Returns the first (least conservative) column with n/(n+1) rhat + B/(n+1) <= alpha, which guarantees E[loss] <= alpha
    over the calibration and a new exchangeable unit; None when no column qualifies. No high-probability statement."""
    if np.any(np.diff(losses, axis=1) > 1e-12):
        raise ValueError("CRC needs each unit's loss to be non-increasing as the rule grows more conservative")
    if np.any(losses[:, -1] > alpha + 1e-12):
        raise ValueError("CRC needs the most conservative rule to have loss at most alpha")
    n = losses.shape[0]
    ok = np.nonzero(n / (n + 1) * losses.mean(0) + bound / (n + 1) <= alpha)[0]
    return int(ok[0]) if len(ok) else None


GRID = tuple(np.round(np.linspace(1.0, 0.0, 101), 4))     # fixed before any label is seen: score thresholds, strictest first


def group_losses(rows: list[dict], scores: np.ndarray, kind: str, grid=GRID) -> tuple[np.ndarray, list[str]]:
    """Per-group loss at each threshold. `accepted_error` is (accepted wrong)/(accepted), 0 when nothing is accepted: not
    monotone, so LTT. `error_mass` is (accepted wrong)/(all predicted values of the group): monotone in the threshold, so
    CRC. Groups, not fields or documents, are the units."""
    by_group: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_group[r["group"]].append(i)
    y = np.array([r["y"] for r in rows])
    names = sorted(by_group)
    out = np.zeros((len(names), len(grid)))
    for g, name in enumerate(names):
        idx = np.array(by_group[name])
        for j, tau in enumerate(grid):
            accepted = scores[idx] >= tau
            wrong = int(((y[idx] == 0) & accepted).sum())
            out[g, j] = (wrong / accepted.sum() if accepted.any() else 0.0) if kind == "accepted_error" else wrong / len(idx)
    return out, names


def certify(rows: list[dict], scores: np.ndarray, *, alpha: float, delta: float, method: str = "ltt", grid=GRID) -> dict:
    """A risk-controlling threshold from calibration rows, or an explicit 'unavailable'. LTT controls the expected
    per-group accepted-error fraction (0 for a group that accepts nothing) with probability 1-delta over the calibration
    draw; CRC controls the expected per-group error mass in expectation. Neither controls the pooled accepted-field error
    rate; that micro rate is reported beside the group (macro) rate."""
    if method not in ("ltt", "crc"):
        raise ValueError("method is ltt or crc")
    kind = "accepted_error" if method == "ltt" else "error_mass"
    losses, groups = group_losses(rows, scores, kind, grid)
    n = len(groups)
    info = {"method": method, "unit": "group", "groups": n, "alpha": alpha, "delta": delta if method == "ltt" else None,
            "loss": kind, "grid": [float(grid[0]), float(grid[-1]), len(grid)], "certified": False, "threshold": None,
            "assumes": ("calibration groups independent and identically distributed with deployment groups" if method == "ltt"
                        else "calibration and deployment groups exchangeable")}
    if method == "ltt":
        floor = math.log(delta) / math.log(1 - alpha)
        if n < floor:
            return {**info, "reason": f"{n} groups are too few: certifying even zero errors needs at least {math.ceil(floor)}"}
        result = ltt_fixed_sequence(losses, alpha, delta)
        if not result["accepted"]:
            return {**info, "reason": "the first rule was not certified"}
        best = result["accepted"][-1]                       # the least conservative certified threshold
    else:
        if 1 / (n + 1) > alpha:
            return {**info, "reason": f"{n} groups are too few: alpha must be at least B/(n+1) = {1 / (n + 1):.3f}"}
        flipped = losses[:, ::-1]                            # CRC wants least conservative first
        try:
            index = crc_index(flipped, alpha)
        except ValueError as error:
            return {**info, "reason": str(error)}
        if index is None:
            return {**info, "reason": "no threshold satisfies the CRC bound"}
        best = len(grid) - 1 - index
    tau = float(grid[best])
    y = np.array([r["y"] for r in rows])
    calibration = at_threshold(scores, y, tau)
    if not calibration["accepted"]:
        return {**info, "reason": "only a rule that accepts nothing on the calibration set is certified (vacuous)",
                "threshold_tested": tau}
    return {**info, "certified": True, "threshold": tau, "calibration": calibration,
            "guarantee": ("P(R(threshold) <= alpha) >= 1 - delta over the calibration draw, R the expected per-group accepted-error "
                          "fraction" if method == "ltt" else "E[per-group error mass at the threshold] <= alpha, over calibration and a "
                          "new exchangeable group")}


def micro_macro(rows: list[dict], scores: np.ndarray, tau: float) -> dict:
    """Accepted-field error pooled over fields (micro) and averaged over groups (macro), with the automation coverage:
    the two answer different questions and are never substituted for each other."""
    y = np.array([r["y"] for r in rows])
    accepted = scores >= tau
    per_group = defaultdict(lambda: [0, 0])
    for r, a, yi in zip(rows, accepted, y, strict=True):
        if a:
            per_group[r["group"]][0] += 1
            per_group[r["group"]][1] += int(yi == 0)
    groups = {r["group"] for r in rows}
    macro = float(np.mean([per_group[g][1] / per_group[g][0] if per_group[g][0] else 0.0 for g in groups])) if groups else None
    return {**at_threshold(scores, y, tau), "groups": len(groups), "micro_accepted_error": float((y[accepted] == 0).mean()) if accepted.any() else None,
            "macro_group_accepted_error": macro, "groups_accepting": sum(1 for g in groups if per_group[g][0])}
