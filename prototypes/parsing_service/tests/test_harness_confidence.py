"""Confidence: metrics with known answers, fusion and calibration without leakage, and the risk-control guarantees
falsified by simulation. A simulation can reveal a wrong implementation; it cannot prove validity."""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy import stats

from experiments.harness import confidence as cf


def rows(scores_signals, ys, split="fit", group="g"):
    return [{"doc": f"d{i}", "group": group if isinstance(group, str) else group[i], "split": split, "y": int(y), "signals": s}
            for i, (s, y) in enumerate(zip(scores_signals, ys, strict=True))]


# --- metrics --------------------------------------------------------------------------------------------------------------

def test_metrics_have_their_known_values():
    p, y = np.array([0.9, 0.8, 0.7, 0.6]), np.array([1, 1, 0, 1])
    coverage, risk = cf.risk_coverage(p, y)
    assert coverage.tolist() == [0.25, 0.5, 0.75, 1.0] and risk.tolist() == pytest.approx([0, 0, 1 / 3, 1 / 4])
    assert cf.aurc(p, y) == pytest.approx((0 + 0 + 1 / 3 + 1 / 4) / 4)
    assert cf.coverage_at_risk(p, y, 0.1) == 0.5 and cf.coverage_at_risk(p, y, 0.3) == 1.0
    assert cf.errors_captured(p, y, 0.25) == 0.0 and cf.errors_captured(p, y, 0.5) == 1.0        # the wrong value is second lowest
    assert cf.brier(p, y) == pytest.approx(np.mean([0.01, 0.04, 0.49, 0.16]))
    assert cf.auroc(p, y) == pytest.approx(2 / 3)                                                    # 2 of 3 right values outrank the wrong one
    assert cf.auroc(np.array([0.5, 0.5]), np.array([1, 0])) == 0.5 and cf.auroc(p, np.ones(4, dtype=int)) is None
    assert cf.ece(np.array([0.95, 0.95, 0.05, 0.05]), np.array([1, 1, 0, 0])) == pytest.approx(0.05)


def test_tied_scores_are_accepted_together_so_row_order_cannot_change_a_curve_or_a_review_budget():
    p, y = np.array([0.5, 0.5, 0.9, 0.1]), np.array([1, 0, 1, 0])
    for order in ([0, 1, 2, 3], [1, 0, 2, 3], [3, 2, 1, 0]):
        q, z = p[order], y[order]
        coverage, risk = cf.risk_coverage(q, z)
        assert coverage.tolist() == [0.25, 0.75, 1.0] and risk.tolist() == pytest.approx([0, 1 / 3, 1 / 2])   # no point inside the tie
        assert cf.aurc(q, z) == pytest.approx(0.5 / 3 + 0.25 / 2)
        assert cf.coverage_at_risk(q, z, 0.4) == 0.75
        assert cf.errors_captured(q, z, 0.5) == pytest.approx(0.75)                                   # the tie at the cut is reviewed at random


def test_a_review_budget_of_zero_captures_nothing_and_an_impossible_one_is_refused():
    p, y = np.array([0.1, 0.5, 0.9]), np.array([0, 1, 1])
    assert cf.errors_captured(p, y, 0.0) == 0.0 and cf.errors_captured(p, y, 1.0) == 1.0
    with pytest.raises(ValueError, match="between 0 and 1"):
        cf.errors_captured(p, y, 1.5)


def test_a_filtered_population_never_beats_the_whole_and_a_violation_is_detected():
    rng = np.random.default_rng(3)
    p = rng.random(300)
    y = (rng.random(300) < p).astype(int)
    assert cf.check_filter_invariant(p, y) == []
    for tau in (0.2, 0.5, 0.9):
        info = cf.at_threshold(p, y, tau)
        assert info["automation_coverage"] * info["accepted_accuracy"] <= (y == 1).mean() + 1e-12
    assert cf.at_threshold(p, y, 2.0)["accepted_error_rate"] is None                                # nothing accepted: no rate, not zero


# --- fusion and calibration -------------------------------------------------------------------------------------------------

def population(n, seed, missing=0.0):
    rng = np.random.default_rng(seed)
    p = rng.random(n)
    y = (rng.random(n) < special_sigmoid(6 * (p - 0.5))).astype(int)
    signals = [{"p_first": float(pi) if rng.random() >= missing else None, "agreement": float(rng.random())} for pi in p]
    return signals, y


def special_sigmoid(z):
    return 1 / (1 + np.exp(-z))


def test_fusion_learns_the_informative_signal_ranks_held_out_errors_and_never_sees_other_splits():
    fit_signals, fit_y = population(600, 1)
    fusion = cf.fit_fusion(rows(fit_signals, fit_y))
    weights = dict(zip(fusion.names, fusion.weights[:len(fusion.names)], strict=False))
    assert weights["p_first"] > abs(weights["agreement"]) * 3
    test_signals, test_y = population(600, 2)
    assert cf.auroc(fusion.score(test_signals), test_y) > 0.75
    with pytest.raises(ValueError, match="split 'fit' only"):
        cf.fit_fusion(rows(fit_signals, fit_y, split="calibration"))
    constant = cf.fit_fusion(rows(fit_signals, np.ones(600)))
    assert constant.score(test_signals[:3]) == pytest.approx([1.0] * 3, abs=1e-3)                    # one class: its rate, no invented signal


def test_a_missing_signal_is_neither_zero_nor_the_mean_it_is_its_own_feature():
    signals, y = population(800, 4, missing=0.3)
    fusion = cf.fit_fusion(rows(signals, y))
    assert "p_first" in fusion.indicators and fusion.fill["p_first"] == pytest.approx(0.5, abs=0.06)
    missing = fusion.score([{"p_first": None, "agreement": 0.5}])[0]
    zero = fusion.score([{"p_first": 0.0, "agreement": 0.5}])[0]
    assert missing > zero + 0.1                                                                       # missing is not the worst score
    assert cf.rank_score({"p_first": None, "conflict": None}) is None                                 # nothing to rank on
    assert cf.rank_score({"p_first": 0.8, "verdict": None, "conflict": 1.0}) == pytest.approx((0.8 + 0.0) / 2)   # missing left out, not 0


def test_calibrators_are_monotone_and_reduce_brier_on_held_out_data():
    rng = np.random.default_rng(9)
    def draw(n):
        truth = rng.random(n)
        return truth ** 3, (rng.random(n) < truth).astype(int)                                           # a monotone distortion of the truth
    cal_scores, cal_y = draw(2000)
    test_scores, test_y = draw(2000)
    base = cf.brier(test_scores, test_y)
    for calibrator in (cf.Platt(), cf.Isotonic()):
        calibrator.fit(cal_scores, cal_y)
        assert cf.brier(calibrator.predict(test_scores), test_y) < base
        grid = calibrator.predict(np.linspace(0.001, 0.999, 50))
        assert np.all(np.diff(grid) >= -1e-9)
    tied = cf.Isotonic().fit(np.array([0.5, 0.5, 0.5, 0.9]), np.array([1, 0, 0, 1]))
    assert tied.predict(np.array([0.5]))[0] == pytest.approx(1 / 3)                                    # ties averaged before pooling


# --- risk control: exact formulas -------------------------------------------------------------------------------------------

def test_the_conformal_quantile_is_inclusive_and_becomes_the_full_label_set_when_it_cannot_be_met():
    scores = np.array([0.1, 0.4, 0.2, 0.3, 0.5])
    assert cf.conformal_quantile(scores, 0.2) == 0.5 and cf.conformal_quantile(scores, 0.4) == 0.4      # k = ceil(6 * 0.8) = 5, ceil(6 * 0.6) = 4
    assert cf.conformal_quantile(scores, 0.1) == math.inf                                                  # k = ceil(6 * 0.9) = 6 > 5
    assert cf.conformal_set({"a": 0.6, "b": 0.5, "c": 0.1}, 0.5) == ["a", "b"]                            # 1 - 0.5 = 0.5 <= 0.5: inclusive
    assert cf.conformal_set({"a": 0.6, "b": 0.5, "c": 0.1}, math.inf) == ["a", "b", "c"]


def test_split_conformal_refuses_dependent_units():
    calibration = [("doc1", {"a": 0.7, "b": 0.3}, "a"), ("doc1", {"a": 0.6, "b": 0.4}, "b")]
    with pytest.raises(ValueError, match="one observation per unit"):
        cf.split_conformal(calibration, 0.1)
    ok = cf.split_conformal([(f"d{i}", {"a": 0.8, "b": 0.2}, "a") for i in range(20)], 0.1)
    assert ok["unit"] == "document" and ok["qhat"] == pytest.approx(0.2)


def test_the_hoeffding_bentkus_pvalue_has_its_known_limits():
    n, alpha = 50, 0.1
    assert cf.hb_pvalue(0.0, n, alpha) == pytest.approx((1 - alpha) ** n)                               # zero errors: (1 - alpha)^n
    assert cf.hb_pvalue(alpha, n, alpha) == 1.0 and cf.hb_pvalue(0.5, n, alpha) == 1.0                  # not below alpha: nothing to reject
    assert cf.hb_pvalue(0.02, n, alpha) < cf.hb_pvalue(0.05, n, alpha) < cf.hb_pvalue(0.08, n, alpha)


def test_fixed_sequence_testing_stops_at_the_first_failure_and_never_skips_over_it():
    n = 60
    losses = np.zeros((n, 5))
    losses[:, 1] = 0.0
    losses[:, 2] = np.r_[np.ones(20), np.zeros(n - 20)]        # risk 1/3: fails
    losses[:, 3] = 0.0                                          # would pass, but the sequence has already stopped
    result = cf.ltt_fixed_sequence(losses, alpha=0.1, delta=0.1)
    assert result["accepted"] == [0, 1] and len(result["pvalues"]) == 3


def test_crc_needs_monotone_bounded_losses_and_picks_the_first_qualifying_rule():
    n = 100
    losses = np.zeros((n, 4))
    losses[:20, 0] = 1.0                                       # least conservative: risk 0.2
    losses[:5, 1] = 1.0                                        # risk 0.05: n/(n+1) 0.05 + 1/(n+1) ~ 0.0594 <= 0.1
    assert cf.crc_index(losses, alpha=0.1) == 1
    with pytest.raises(ValueError, match="non-increasing"):
        cf.crc_index(losses[:, ::-1], alpha=0.1)
    bad = losses.copy()
    bad[:, -1] = 0.5
    with pytest.raises(ValueError):
        cf.crc_index(bad, alpha=0.1)
    assert cf.crc_index(np.zeros((10, 3)), alpha=0.05) is None                        # the finite-sample floor: alpha < B/(n+1)


# --- risk control: the guarantees, by simulation -----------------------------------------------------------------------------

def one_sided_lower(k: int, m: int, level: float = 0.99) -> float:
    """A 99% Clopper-Pearson lower bound on a probability estimated by k failures in m replications."""
    return 0.0 if k == 0 else float(stats.beta.ppf(1 - level, k, m - k + 1))


@pytest.mark.parametrize("risks", [[0.0, 0.01, 0.03, 0.06, 0.12, 0.3],           # monotone, first unsafe rule at index 4
                                   [0.0, 0.15, 0.02, 0.03, 0.04, 0.05]])          # non-monotone: index 1 is unsafe though later ones are safe
def test_ltt_selects_an_unsafe_rule_with_probability_at_most_delta(risks):
    alpha, delta, n, reps = 0.10, 0.10, 60, 3000
    rng = np.random.default_rng(11)
    unsafe = {j for j, r in enumerate(risks) if r > alpha}
    bad = 0
    for _ in range(reps):
        losses = (rng.random((n, len(risks))) < np.array(risks)).astype(float)
        bad += bool(unsafe & set(cf.ltt_fixed_sequence(losses, alpha, delta)["accepted"]))
    assert one_sided_lower(bad, reps) <= delta, f"{bad}/{reps} unsafe selections"
    assert bad / reps < delta                                                             # and it is not vacuous: it certifies something
    chosen = sum(bool(cf.ltt_fixed_sequence((rng.random((n, len(risks))) < np.array(risks)).astype(float), alpha, delta)["accepted"])
                 for _ in range(300))
    assert chosen > 150


def test_crc_keeps_the_expected_loss_of_a_new_unit_at_most_alpha():
    alpha, n, reps = 0.10, 40, 6000
    rng = np.random.default_rng(5)
    risk = np.array([0.5, 0.3, 0.12, 0.06, 0.0])                                      # least to most conservative
    test_losses = []
    for _ in range(reps):
        u = rng.random(n)
        losses = (u[:, None] < risk[None, :]).astype(float)                            # monotone per unit
        index = cf.crc_index(losses, alpha)
        chosen = risk[index] if index is not None else 0.0                             # no qualifying rule: abstain on everything
        test_losses.append(float(rng.random() < chosen))
    mean = float(np.mean(test_losses))
    assert mean <= alpha + 3 * math.sqrt(alpha * (1 - alpha) / reps)


def test_split_conformal_coverage_is_at_least_one_minus_alpha_and_near_it():
    alpha, n, reps = 0.10, 30, 40000
    rng = np.random.default_rng(1)
    calibration = np.sort(rng.random((reps, n)), axis=1)
    test = rng.random(reps)
    k = math.ceil((n + 1) * (1 - alpha))
    covered = test <= calibration[:, k - 1]
    rate, se = covered.mean(), math.sqrt(0.9 * 0.1 / reps)
    assert rate >= 1 - alpha - 4 * se and rate <= 1 - alpha + 1 / (n + 1) + 4 * se


def test_degenerate_inputs_are_uncertified_not_approximated():
    scores = np.full(200, 0.5)
    y = np.r_[np.ones(180), np.zeros(20)].astype(int)
    many = rows([{}] * 200, y, split="calibration", group=[f"g{i}" for i in range(200)])
    tied = cf.certify(many, scores, alpha=0.05, delta=0.1)
    assert tied["certified"] is False and "vacuous" in tied["reason"]                    # every score tied: all or nothing, and 10% wrong
    few = rows([{}] * 10, np.ones(10, dtype=int), split="calibration", group=[f"g{i}" for i in range(10)])
    assert "too few" in cf.certify(few, np.ones(10) * 0.9, alpha=0.1, delta=0.1)["reason"]
    assert "too few" in cf.certify(few[:5], np.ones(5) * 0.9, alpha=0.1, delta=0.1, method="crc")["reason"]
    good = rows([{}] * 300, np.ones(300, dtype=int), split="calibration", group=[f"g{i}" for i in range(300)])
    result = cf.certify(good, np.linspace(0.5, 1.0, 300), alpha=0.05, delta=0.1)
    assert result["certified"] and result["unit"] == "group" and result["threshold"] is not None
    assert result["calibration"]["accepted_error_rate"] == 0.0 and result["calibration"]["automation_coverage"] > 0.5
    empty = cf.certify(many, np.zeros(200), alpha=0.05, delta=0.1)                                 # every score 0: accept-all or nothing
    assert empty["certified"] is False                                                             # nothing crashes at an empty acceptance


def test_certification_uses_groups_and_micro_and_macro_risk_are_reported_apart():
    assert cf.certify([], np.array([]), alpha=0.1, delta=0.1)["groups"] == 0
    a = rows([{}] * 100, np.r_[np.ones(90), np.zeros(10)], group="A")
    b = rows([{}] * 1, [0], group="B")
    both, scores = a + b, np.ones(101)
    report = cf.micro_macro(both, scores, 0.5)
    assert report["micro_accepted_error"] == pytest.approx(11 / 101)
    assert report["macro_group_accepted_error"] == pytest.approx((0.10 + 1.0) / 2)                  # the two differ, and both are shown
    losses, names = cf.group_losses(both, scores, "accepted_error")
    assert names == ["A", "B"] and losses.shape == (2, len(cf.GRID)) and losses[0, 0] == pytest.approx(0.10)
