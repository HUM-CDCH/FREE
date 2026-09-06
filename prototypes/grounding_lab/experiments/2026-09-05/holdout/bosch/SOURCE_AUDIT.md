# Bosch source audit — 2026-09-05

Status: source-only first-20 eligibility review; no identified selected-record overlap in the supplied prior claim files. This is not a claim label set. No holdout model outputs, pilot runs, policy code or grounding outcomes were inspected.

## Source and selection

Original `Katalog and tables.pdf` contains 210 pages with embedded text. The title page explicitly supplies Tobias Ludwig Bosch, the dissertation title and 2008; the examination date on the next page is 2009 and is not silently substituted for the title-page year. Catalogue prose starts on PDF page 4 / printed 212. The first 20 eligible catalogue records are **1, 2, 3.1, 3.2, 4, 5, 6.1, 6.2, 7.1–7.12**, ending at Burgweinting Obj. 3087b, PDF page 12 / printed 220. The original PDF was not changed. Original pages and extracted `document.md` were inspected.

One record represents one separately catalogued grave feature. Cemetery totals and contextual references to other graves do not create additional target catalogue records: Atting Befunde 5308, 2335, 2340 and 2415, and Burgweinting Objekte 1, 233, 4152 and 4153 occur in introductory context. Barbing's so-called Grab 4 is described as a ceramic deposit, not a separately catalogued burial here. This catalogue-entry interpretation is recorded because a literal every-mentioned-feature interpretation would change the boundary.

Catalogue 7.4 / Obj. 3080 contains two individuals but only one grave. Catalogue 7.10 / Obj. 3086 explicitly identifies a grave pit despite no surviving burial traces. It is eligible as a definite feature; this does not establish zero individuals or a cenotaph. Catalogue 7.11 and 7.12 separately identify 3087a and 3087b, so both are selected. The prose is internally inconsistent about which cuts which: the 7.11 description and later part of 7.12 identify a as younger, while the opening of 7.12 reverses the relationship. No unsupported resolution is imposed.

## Source representation and attribute limitations

The parsed text preserves all 20 selected catalogue headings and their order. It detaches illustration references and interleaves fragments: the Altdorf age/sex sentence is reordered, and part of the Atting dagger description appears at the end of the Aufhausen opening. An extractor may not safely assign every intervening fragment by nearest heading alone. No parser repair was performed.

Burgweinting repeatedly gives different dimensions for Planum 1, Planum 2 and internal stains. These must remain distinct from each other and from grave-good dimensions. Stated approximate/range values do not become exact numbers, and age classes do not establish numeric ages. Barbing Grab 7 and Burgweinting Obj. 3081 have uncertain sex/posture attributes within definite graves; that uncertainty is retained as text or null according to the frozen field type.

## Prior-record overlap audit

All twelve prior files were scanned: six `final_dataset_3/*/claims.json` files containing 164 claims and six `claims_extracted.json` files containing 360 claims, **524 entries total**. The scan searched claim values and scalar contexts, excluding notes/bibliography, with case-folding and diacritic removal. Selected sites/aliases checked: Aiterhofen, Altdorf, Atting, Aufhausen, Augsburg, Haunstetten, Barbing and Burgweinting.

There were **zero site/alias hits**. No selected site plus grave/feature identifier overlap was identified across the supplied prior claim files. Matching bare grave numbers would not establish identity. The untouched designation is limited to this available prior-use evidence; it does not certify absence from all prior source prose, hidden records, unrecorded aliases or training data.

The manifest supplies source identities and selection boundaries, not ground-truth support judgments for emitted model attributes.

## Extended audit of all six prior full source texts

The extended audit searched the complete supplied `document.md` texts of all six prior families: `buchvaldek-1970-vikletice-tables-de`, `buchvaldek-koutecky-1972-vikletice-de`, `conrad-2011-bbc-graves-de`, `dobes-1998-kugelamphoren-de`, `durankulak-catalogue-de` and `shbat-2009-skeletal-health-en`. Search terms were selected manifest sites, municipalities and the aliases listed above. Checks included whole-word case-folded matching, diacritic removal, German ae/oe/ue variants, whitespace normalization and joining line-ending hyphenation. Candidate matches were read in context. Source page references below are one-based `FREE:PAGE` markers; line references are one-based lines in the prior markdown. This extends the earlier 524-claim audit; it does not inspect holdout model outputs or claim-support judgments.

There were **zero selected-site or known-alias hits** for this family across the six complete prior texts, including the normalized/transliterated search. There are therefore no candidate substantive selected-record matches to promote from citation exposure. Bare grave/feature identifiers were not treated as globally unique. The **untouched** status remains supported by both the supplied prior claims and supplied prior full-source texts, with no identified prior selected-record use.

This is a bounded negative finding, not a guarantee: damaged OCR, unknown historical aliases, translations and descriptions omitting site names can evade name-based search. The earlier paragraph's limitation concerning unsearched prior prose is narrowed by this extension to prose outside these six supplied markdown sources. No new evaluation outputs or support labels were read.
