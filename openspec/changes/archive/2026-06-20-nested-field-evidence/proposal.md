## Why

The evidence highlight layer currently colors PDF highlights by schema depth: all depth-0 fields share one yellow, all depth-1 fields share one blue, all depth-2 fields share one green. This makes it impossible to tell which highlighted passage belongs to which extracted field — a researcher looking at three yellow rectangles on the page cannot know which one is `grave id`, which is `interpretation`, and which is `dating`.

The goal is to assign each **top-level key** its own distinct color, so every highlighted passage is unambiguously linked to one semantic section of the extraction result.

## Goal — example

Given an extraction result like:

```json
{
    "grave id": "8",
    "ark": "67",
    "photo_references": {
        "digital": "238-39, 246-48",
        "black_and_white_film": {
            "film": "4",
            "frames": "22-23"
        }
    },
    "background_and_excavation": "Anlægget blev oprindelig tolket...",
    "description": {
        "shape": "Langovalt fyldskifte af noget amorf form",
        "fill": "Lyst gråbrunt sandet ler",
        "orientation": "NØ-SV"
    },
    "skeleton": {
        "anthropological_assessment": {
            "sex": "Mand (?)",
            "age": "Over 45 år"
        }
    },
    "interpretation": "Jordfæstegrav",
    "dating": "Uvis, yngre romersk jernalder (?)"
}
```

Coloring strategy:
- A fixed palette of **4 colors** is cycled through in top-level key order.
- Adjacent top-level keys always receive different colors (guaranteed by the 4-color cycle — no two consecutive keys share a slot).
- Any nested field that gains evidence in the future inherits the color of its top-level ancestor.
- Top-level object fields (`description`, `skeleton`, …) currently produce no highlights because no evidence is generated for them on the backend — this is correct behavior for now.

## What Changes

- `DEPTH_COLORS` (indexed by depth 0/1/2) is replaced with a fixed 4-color palette cycled by top-level key order (`index % 4`).
- `buildDepthMap` (which tracked per-field depth) is replaced by a function that maps each top-level scalar key to its palette index.
- `depthColor(fieldKey, depthMap)` is replaced by a lookup that takes a top-level key and returns its assigned palette color.
- The change is **frontend-only**. Backend evidence generation (`evidence_template.py`) is unchanged.

## Capabilities

### New Capabilities

### Modified Capabilities
- `evidence-highlight-layer`: Color assignment changes from depth-based to top-level-key-based. Each top-level key in the schema receives a unique color; all evidence items for that key (including future nested ones) share it.

## Impact

- `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx`: replace `DEPTH_COLORS`, `buildDepthMap`, `depthColor` with a top-level-key palette scheme.
