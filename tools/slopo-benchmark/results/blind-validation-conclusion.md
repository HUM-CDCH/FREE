# Slopo ensemble validation conclusion

## Decision

The frozen ensemble is accepted only as a repository-calibrated workflow for
FREE. It is not accepted as a portable default for unrelated repositories.

The decisive production-only holdout failed: on FastAPI 0.139.2, pplx returned
6/20 coherent clusters and the consensus ranking returned 5/20. Reusing FREE's
model thresholds and 0.60 fusion cutoff across repositories would therefore be
unsafe.

## Evidence

| Corpus | Scope | pplx P@20 | Consensus P@20 | Gate result |
|---|---|---:|---:|---|
| FREE | Repository-calibrated evaluation | 18/20 | 20/20 | In-sample evidence |
| Installed Slopo 0.5.0 | 46 production files | 7/12 | 7/12 | Inconclusive sample; low observed precision |
| Slopo commit `3bc52539f8b6386707302a2f58e3ab77fbbc73f3` | 46 production files plus 92 test files, including 54 fixtures | 18/20 | 19/20 | Passed, but scope does not match production exclusions |
| FastAPI 0.139.2 | 48 production files, no tests or fixtures | 6/20 | 5/20 | **Failed** |

Every holdout used the dimensions, per-model thresholds, top-50 pool, 0.60
member-Jaccard cutoff, and 90% P@20 acceptance rule frozen before review. Review
queues hid model identity, support, rank, and similarity. No holdout threshold
was retuned.

## Failure analysis

On FastAPI, consensus replaced nine pplx top-20 candidates. The entering set
contained one positive and eight negatives; the displaced set contained two
positives and seven negatives. Agreement therefore removed several false
positives but promoted even more related-but-distinct code.

The recurrent failure modes were:

- application wrappers clustered with router or persistence implementations;
- base-class methods clustered with subclasses exposing different contracts;
- nested decorator bodies clustered with their containing functions;
- route matching, traversal, or serialization stages clustered because their
  control-flow shape was similar;
- three-model support amplified these structural similarities rather than
  providing independent semantic evidence.

Neither sample-sized blind holdout produced a confirmed top-20 positive absent
from the primary model's top-50 candidate pool. The observed top-rank benefit on
FREE and the test-heavy Slopo corpus came from reranking, not new discovery.

## Operational use

For FREE, keep `consensus_only` as the high-confidence review queue and retain
`support_first` as an explicitly lower-precision exploration tail. Regenerate
them from cached model output with:

```powershell
python tools/slopo-benchmark/ensemble.py
```

For another repository, build a repository-specific labeled calibration set and
retune its per-model thresholds before using fusion. Do not copy FREE's numeric
thresholds.

The next portable-algorithm experiment should split connected components using
a cluster-coherence rule (for example complete-linkage or a minimum pairwise
cohesion gate) before rank fusion, then validate it on a new untouched
production-only package. FastAPI is now calibration data and cannot serve as
that final holdout again.
