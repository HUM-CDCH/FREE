"""Reuse a validated segmentation or compute and publish it from canonical evidence."""
from pathlib import Path

from kei_exp.kie.passages import Evidence
from kei_exp.kie.recipe import Recipe
from kei_exp.kie.segmentation import Segmentation, SegmentationInvalid, load_segmentation, publish_segmentation
from kei_exp.kie.stages import segment as segmenter


def obtain(run_dir: Path, evidence: Evidence, recipe: Recipe) -> Segmentation:
    """The proven published artifact, or a new one computed and published in its place."""
    try:
        found = load_segmentation(run_dir, evidence, recipe)
    except SegmentationInvalid:
        found = None
    if found is not None:
        return found
    made = segmenter.segment(evidence, recipe)
    publish_segmentation(run_dir, made)
    return made
