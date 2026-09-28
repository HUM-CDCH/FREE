# Merged grounding code: captured-response regression — 2026-09-28

Status: **nine real-capture cases match the merged code with network blocked**.
PRs #145 and #146 are merged into `feat/kei-exp-parser`; this check pins merge
commit `2ce78e4c8c77fa3efd1b9f31b7abe38f67442b16`. It does not change the primary
checkout, source documents, historical captures or production defaults.

The earlier integration checks used scripted replies. This additional check
uses the saved replies from the completed development pilots:

| Captured cases | Cells | Requests replayed | Boundary checked |
|---|---:|---:|---|
| Harvey quoted table/prose, two repeats | 4 | 4 | Technique dispatch, verifier, canonical cells/geometry and diagnostics |
| Harvey compact spans table/prose, two repeats | 4 | 8 | Same boundary, plus exact span IDs, offsets and reconstructed quotes |
| Zelechowska complete quoted-grounding cell | 1 | 40 | Shared `assembly.ground_records`, fixed-upstream artifact and fingerprint |

All 52 regenerated requests match the captured requests after identical JSON
serialization, including schema property order. All replies are consumed exactly
once per case. Harvey results match entirely; the full Zelechowska artifact matches
except top-level start/elapsed clocks. Its captured call durations remain unchanged.
The check verifies 493 source/code/input/capture/probe pins before and after use.

HTTP requests and socket connections are blocked. There are zero new
model or tokenizer calls. The eight Harvey cells preserve both their accepted
table cells and the incompletely supported DSC-condition claim; reproducing a
defect is not semantic validation. The original v1 span cells are intentionally
excluded because compact labels change their requests and admission behavior.
This supports unchanged behavior on these paths, not a fresh integrated evaluation,
complete branch coverage, verifier equivalence on arbitrary inputs, or accuracy.

The archived service and verifier are under
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/merged-capture-replay-20260928/`.

| Artifact | SHA-256 |
|---|---|
| `merged-code.zip` | `dcbecf52076fe177396c5a665b028c66cb7c41cde1355cf07df234c9af49372f` |
| `runtime.json` | `585b1e585e47b64f132b73a344f2ba6e885931ade74df8bfe1efc95bdaa32afe` |
| `replay.py` | `6851adde9fcb4adedd812720d0eb29697a58c20b19e8a98275ae50447f4f7815` |
| `verification.json` | `49c97b4cbaceff4aec4ad3fce65d71927bbd3ceb07a16affbf53eab3b2716adc` |
| `../development-exposure-20260928.json` | `cd7f08ae81de52cd61efefb5e5c5ff9dc5faf5ac136364cc70288d596a11cc13` |

From the archive's `source/prototypes/parsing_service` directory, repeat without
network using a new receipt filename:

```sh
PYTHONPATH=src:. PYTHONDONTWRITEBYTECODE=1 \
  /home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python \
  /home/gennaro/projects/FREE/artifacts/extraction-ablation/merged-capture-replay-20260928/replay.py \
  /tmp/merged-grounding-replay-new.json
```

The merged compact-label PR head `0843d247` has a successful GitHub `verify`
check. At inspection, no separate check was reported on this merge SHA; the local captured-response
check above is the evidence added for that exact merged revision. Other CI/test
claims remain scoped to their reported heads.

The corpus refresh found the same 16 sources across the five registered study
manifests: six papers with non-exhaustive development gold and ten unannotated
examples. The separately pinned `development-exposure-20260928.json` ledger
records their PDF identities and treats all 16 as development-exposed. Family
labels remain unknown; none is declared eligible as an untouched holdout.
This is an inventory of known study sources, not a claim to have searched every
local PDF. No independently annotated, untouched set has been supplied.

The full R4/R5 matrix stays deferred. The
[completed-development report](2026-09-28-completed-development-study.md) and
[independent evaluation gate](../plans/2026-09-27-modular-extraction-ablation-study.md#m7--independent-evaluation-after-policy-freeze)
remain the boundaries for interpreting the results.
