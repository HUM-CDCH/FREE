"""Page geometry of a recorded run, for the viewer: the crops that were the transcriber's input and the segments
found in them, in PDF page points, projected from the page's accepted result (kei_exp.pagefile.PageResult).

The page file is read as a dict, and only through keys that page files of version 3 and 4 share, so runs recorded
before RESULT_VERSION 4 keep their viewer; the projection's own shape is the web app's `PageBoxes` and does not
change with the page file."""
from collections.abc import Iterable

Point = tuple[float, float]


def page_geometry(number: int, size: Point, result: dict | None, events: Iterable[dict]) -> dict:
    """The viewer's projection of one page: `regions` (the crops, unit by unit) and `blocks` (the segments), both
    in page points. Before the page's result is published, the crops come from the run's region events."""
    width, height = size
    regions: list[dict] = []
    blocks: list[dict] = []
    if result:
        for unit in result["units"]:
            for crop in unit["crops"]:
                regions.append({"crop": crop["crop"], "unit": unit["index"], "kind": crop["kind"], "order": crop["order"],
                                "bbox": list(crop["bbox_pt"]), "ink": crop["ink"], "image": list(crop["image_px"]),
                                "output_tokens": crop["output_tokens"], "incomplete": crop["incomplete"]})
        for order, segment in enumerate(result["segments"]):
            blocks.append({"crop": segment["crop"], "unit": segment["unit"], "order": order, "label": segment["label"],
                           "confidence": segment["confidence"], "bbox": list(segment["bbox_pt"]), "html": segment["html"],
                           "text": segment["text"], "skipped": segment["status"] == "skipped",
                           "error": segment["status"] == "error"})
    else:
        for event in events:
            if event.get("type") == "region" and event["page"] == number:
                regions.append({"crop": event["crop"], "unit": event["unit"], "kind": event["kind"], "order": event["order"],
                                "bbox": list(event["bbox"]), "ink": event.get("ink"),
                                "image": [event["width"], event["height"]], "output_tokens": None, "incomplete": None})
    return {"page": number, "size": [width, height], "published": bool(result), "regions": regions, "blocks": blocks}
