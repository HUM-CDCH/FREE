# Wiermann source audit — 2026-09-05

Status: source-only first-20 eligibility review; no identified selected-record overlap in the supplied prior claim files. This is not a claim label set. No holdout model outputs, pilot runs, policy code or grounding outcomes were inspected.

## Source and selection

Original `OCR/Wiermann2004_03_catalogue.pdf` contains 35 scanned spreads with OCR. Maps/front matter occupy PDF pages 1–10; catalogue entries start PDF page 12. The first 20 eligible catalogue records, reviewed against original PDF pages 12–18 (printed 168–181), are **5, 6, 11–19, 22, 23, 34, 41, 49, 50, 59, 64, 74**. The original PDF was not changed. Source text was read from `document.md`; the manifest preserves original PDF reading order.

The frozen instruction includes explicitly identified grave mounds even without surviving skeletons. Consequently the nine separate Altenbauna mounds (catalogue 11–19) are eligible. Their absence of skeleton evidence does not supply individual counts, sex or age. Each is a separate feature with its printed mound number.

Catalogue 6 identifies Grabhügel 1, Grab 2; the overlying later Hallstatt burial is contextual information, not a separately catalogued target record. Catalogue 23 and 34 respectively identify a mound and stone-cist grave despite sparse descriptions. Catalogue 49 explicitly describes a Bronze Age mound containing a central and four further stone packings; the catalogued finds come from packing III. It is retained as one mound record. The frozen rule has no period restriction and the source does not separately identify all five packings as graves. No invented five-way split is made.

Catalogue 39 is excluded: its finds are only possibly from a flat grave. Catalogue 42 has nearby vessels but no identified grave. Catalogue 65 is only allegedly a crouched burial and is excluded. Catalogue 73 explicitly classifies the finds as stray finds within a later cemetery and is excluded. Other nonselected entries before 74 describe stray finds; neither discovery by excavation nor a nearby cemetery makes them eligible.

Catalogue 64 contains conflicting reported orientations and vessel positions; retain that uncertainty in text, rather than silently choosing a reading. Dimensions of mounds, ash layers, pits and vessels are different measurements. No inferred numeric values or conversions belong in the extraction.

## Source representation limitations

PDF page 15 / printed 174–175 has severely fragmented OCR; catalogue **34 Altendorf, Steinkistengrab** is visibly legible in the original but nearly unrecoverable from the supplied text. This is one definite selected record affected by severe source-representation damage. A simple `Befund:`/`Grab` text search also fails around broken headings and continuation columns. PDF page 12 splits catalogue 6 across the spread, and catalogue 11 continues on the following spread; other records also cross columns. No parser repair was performed. This audit must not imply every original-source attribute is available faithfully in canonical text.

## Prior-record overlap audit

All twelve prior files were scanned: six `final_dataset_3/*/claims.json` files containing 164 claims and six `claims_extracted.json` files containing 360 claims, **524 entries total**. The scan searched claim values and scalar contexts, excluding notes/bibliography, with case-folding and diacritic removal. Selected sites and municipality aliases checked: Allendorf, Frielendorf, Allendorf a. d. Lumda, Altenbauna, Baunatal, Altenbrunslar, Felsberg, Altendorf, Naumburg, Altheim, Münster, Amöneburg, Angersbach, Wartenberg, Astheim, Trebur, Auerbach, Bensheim and Bad Nauheim.

There were **zero site/alias hits**. Therefore no selected site plus grave/feature identifier overlap was identified across the supplied prior claim files. Matching bare mound numbers would not establish identity. This conclusion is limited to those claim files and known names; it does not certify absence from all prior source prose, hidden records, unrecorded aliases or training data.

The 20-record manifest is source-derived and may be used to inspect completeness or selection boundaries. It supplies no ground-truth support judgments for emitted model attributes.

## Extended audit of all six prior full source texts

The extended audit searched the complete supplied `document.md` texts of all six prior families: `buchvaldek-1970-vikletice-tables-de`, `buchvaldek-koutecky-1972-vikletice-de`, `conrad-2011-bbc-graves-de`, `dobes-1998-kugelamphoren-de`, `durankulak-catalogue-de` and `shbat-2009-skeletal-health-en`. Search terms were selected manifest sites, municipalities and the aliases listed above. Checks included whole-word case-folded matching, diacritic removal, German ae/oe/ue variants, whitespace normalization and joining line-ending hyphenation. Candidate matches were read in context. Source page references below are one-based `FREE:PAGE` markers; line references are one-based lines in the prior markdown. This extends the earlier 524-claim audit; it does not inspect holdout model outputs or claim-support judgments.

There were **zero selected-site or known-alias hits** for this family across the six complete prior texts, including the normalized/transliterated search. There are therefore no candidate substantive selected-record matches to promote from citation exposure. Bare grave/feature identifiers were not treated as globally unique. The **untouched** status remains supported by both the supplied prior claims and supplied prior full-source texts, with no identified prior selected-record use.

This is a bounded negative finding, not a guarantee: damaged OCR, unknown historical aliases, translations and descriptions omitting site names can evade name-based search. The earlier paragraph's limitation concerning unsearched prior prose is narrowed by this extension to prose outside these six supplied markdown sources. No new evaluation outputs or support labels were read.
