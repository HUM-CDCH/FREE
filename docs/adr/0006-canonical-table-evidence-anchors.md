# Canonical matching owns table Evidence Anchors

**Status**: Accepted

FREE derives final table Evidence Anchors by matching model-provided Evidence snippets and Extraction Result values against canonical tables. Model-provided page, table, row, and column coordinates are hints rather than authority because an extraction call may see only a section of the Source Document while canonical table indices are document-global.

Catalog follows the deterministic backfill approach proven by `FREE-technical`, with one correction for its hierarchical path: Catalog discards model-provided location hints before matching across canonical tables, accepts only a unique supported cell match, and leaves the Evidence location empty when matching is ambiguous. This avoids section-to-table mapping and prevents a section-local table index from being misread as document-global. Article may use its document-global table inventory as a verified hint, but canonical matching still owns the final Evidence Anchor.

The same principle governs text Evidence in Catalog. Because a Catalog extraction call sees only one section, NuExtract may omit or mis-copy a grounding snippet even when it extracts the value. Catalog therefore grounds text Evidence snippets against the record's own canonical section: it retains a model snippet that is already verbatim, otherwise derives a verbatim snippet from the extracted value where that value occurs in the section, and leaves the snippets empty when the value is absent. Canonical section text, not the model's snippet, owns the retained text Evidence, and an ungrounded (for example metadata-leaked) value never receives a fabricated snippet.
