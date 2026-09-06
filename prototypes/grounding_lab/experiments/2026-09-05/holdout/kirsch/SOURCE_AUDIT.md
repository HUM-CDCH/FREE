# Kirsch source audit — 2026-09-05

Status: source-only first-20 eligibility review; no identified selected-record overlap in the supplied prior claim files. This is not a claim label set. No holdout model outputs, pilot runs, policy code or grounding outcomes were inspected.

## Source and selection

Original `Kirsch 1993 - Middle Neolithic Brandenburg 02.pdf` contains 40 scanned spreads without embedded text. The selected segment begins part-way through the catalogue at printed page 82. Source text was read from `document.md` and checked against original page images. The original PDF was not changed.

The first 20 eligible records under the conservative interpretation below are **311, 315, 316, 325, 331, 356, 363, 364.4, 369.1–369.7, three distinct graves within 370, 371 and 383**, ending on PDF page 11 / printed 102. The manifest follows original PDF column order.

Catalogue 312 Pehlitz is a genuine eligibility ambiguity. Its primary classification says megalithic graves, but the discussion reports that later checks found no indication of them and that the old reports are usable only under reservation. Because the overall monument interpretation is uncertain, it is conservatively excluded. Including this collective entry as one definite record would instead make 371 the twentieth record. Treating the reported twelve monuments as twelve established graves would be unsupported. This boundary uncertainty remains explicit; it is not an extraction-model failure.

Catalogue 315 Stolzenhagen contains two historical descriptions that may refer to the same monument; one collective record is retained. The possible long mound is not evidence for a second separately certain grave. Catalogue 316 has multiple individuals within one cist. Catalogue 363 Tempelberg letters a/b/c identify discovery campaigns and parts of one cist complex; entrance find concentrations are not separate graves.

Catalogue 364 separates settlement material, an animal-bone offering pit and the definite catalogue heading **364.4 C. Flachgrab ('Keller')**. Only C is selected. The old cellar interpretation is superseded by a grave interpretation, while a hypothetical later Grube B within/above it is not an additional definite burial. Dimensions of this later possible feature must not silently replace dimensions of the identified grave.

Schwedt 369.1–369.7 each identify a grave. The author questions whether their reported assemblages are reliable closed contexts; that qualification does not erase the explicit grave identities. Catalogue 369.8 is expressly unassociated stray material and is excluded. Catalogue 370 explicitly states that its three preserved vessels stood at the heads of three different skeletons and therefore came from three different graves. Accordingly it is split three ways. The printed catalogue ID remains **370** for all three; `associated_item_id` 1/2/3 is a source-vessel disambiguator, not an invented grave number. The source also warns that 370 was historically confused with 369. It catalogues them separately, but this leaves residual within-source duplicate uncertainty that this audit cannot resolve.

Falkenhagen 371 and Buckow 383 explicitly identify graves; uncertain grave subtype or construction remains uncertain within those records. Altranft's rejected interpretation and entries classified only as probable graves are excluded, including the probable finds around 378 and 380 before the endpoint.

## Source representation and attribute limitations

The PDF is a four-column spread layout. Paragraph continuations can precede their catalogue headings in extracted reading order, and record 364 spans several columns and pages before its numbered C subsection. The selected boundary therefore uses the original source rather than treating markdown block order as authoritative. Source headings have intermittent spaces in decimal IDs (for example 364. 4); the manifest normalizes spacing only. No parser repair or source-attribute labels were produced.

Source units mix metres, centimetres and historical units with approximate metric equivalents, especially Tempelberg. A quoted historical conversion is not permission to invent conversions for other values. Several depths and sizes are approximate or ranges; a single exact numeric field must remain null where the frozen schema cannot represent the source uncertainty. Object measurements and entrance/chamber/pit measurements are distinct.

## Prior-record overlap audit

All twelve prior files were scanned: six `final_dataset_3/*/claims.json` files containing 164 claims and six `claims_extracted.json` files containing 360 claims, **524 entries total**. The scan searched claim values and scalar contexts, excluding notes/bibliography, with case-folding and diacritic removal. Selected sites/aliases checked: Parstein, Stolzenhagen, Bad Freienwalde, Hohensaaten, Neuendorf, Steinhöfel, Tempelberg, Trebus, Schwedt, Falkenhagen and Buckow. Steinhöfel is an explicit alternative attribution for Neuendorf in the source.

There were **zero site/alias hits**. No selected site plus grave/feature identifier overlap was identified across the supplied prior claim files. Bare catalogue or grave-number matches would not establish identity. Prior bibliographic citation exposure by itself does not establish use of these records. The untouched designation is limited to the available prior-use evidence; it does not certify absence from all prior source prose, hidden records, unrecorded aliases or training data.

The manifest supplies source identities and selection boundaries, not ground-truth support judgments for emitted model attributes.

## Extended audit of all six prior full source texts

The extended audit searched the complete supplied `document.md` texts of all six prior families: `buchvaldek-1970-vikletice-tables-de`, `buchvaldek-koutecky-1972-vikletice-de`, `conrad-2011-bbc-graves-de`, `dobes-1998-kugelamphoren-de`, `durankulak-catalogue-de` and `shbat-2009-skeletal-health-en`. Search terms were selected manifest sites, municipalities and the aliases listed above. Checks included whole-word case-folded matching, diacritic removal, German ae/oe/ue variants, whitespace normalization and joining line-ending hyphenation. Candidate matches were read in context. Source page references below are one-based `FREE:PAGE` markers; line references are one-based lines in the prior markdown. This extends the earlier 524-claim audit; it does not inspect holdout model outputs or claim-support judgments.

There were **zero selected-site or known-alias hits** for this family across the six complete prior texts, including the normalized/transliterated search. There are therefore no candidate substantive selected-record matches to promote from citation exposure. Bare grave/feature identifiers were not treated as globally unique. The **untouched** status remains supported by both the supplied prior claims and supplied prior full-source texts, with no identified prior selected-record use.

This is a bounded negative finding, not a guarantee: damaged OCR, unknown historical aliases, translations and descriptions omitting site names can evade name-based search. The earlier paragraph's limitation concerning unsearched prior prose is narrowed by this extension to prose outside these six supplied markdown sources. No new evaluation outputs or support labels were read.
