# Beier source audit — 2026-09-05

Status: **overlap-flagged transfer-only**, excluded from strict untouched pooled results. No substitute source is selected. This is a source-only eligibility and prior-record overlap review, not claim-support labels. No holdout model output, pilot run, policy code or grounding outcomes were inspected.

## Selection and provenance

Original: `Beier1988_GAC_02_Catalogue.pdf`, 45 image-only PDF pages. Original PDF pages 1–6 (printed 90–101) were visually inspected, and source text was read from `document.md`. The original remains unchanged. The 20 eligible source records in `expected_records.json` end at catalogue 61, Haldensleben/Stadtforst.

The frozen instruction selects explicitly identified graves/features, splitting separately identified subgraves. It excludes probable graves, settlements, stray finds and rejected interpretations. A definite grave classification remains eligible when only its subtype, reuse or attributes are uncertain. The manifest records source identifiers without manufacturing subgrave numbers.

Selected catalogue sequence: **3, 8, 9, 10, 14, 17, 18, 21, 25, 26, 28, 29/b, 30, 40/Steinkiste, 40/b, 42, 51, 53, 55, 61**. `40/Steinkiste` here is a descriptive disambiguator, not a printed source ID; the manifest keeps its subrecord ID null.

## Ambiguities and exclusions

- Catalogue 10 asserts graves but cannot decide between one and two. It is one collective source record because separate subgraves cannot be identified; no invented split.
- Catalogue 21 is explicitly FA: G; its question mark concerns secondary burial status. Included, with uncertainty retained in that attribute.
- Catalogue 25 is FA: G but its explanatory parenthesis says Brandgrab?. Included under the definite primary G classification, without asserting a definite cremation subtype. Whether the parenthesis undermines the entire burial interpretation is a residual ambiguity. Excluding it would shift the endpoint to catalogue 62, Hillersleben. This decision was communicated before writing the manifest.
- Catalogue 26 describes a findspot near findspot 4, not an asserted findspot 4; the numeric identifier is null.
- Catalogue 28 is a definite grave inserted into a settlement pit. The settlement context is not another burial record.
- Catalogue 29 contains probable-grave subentry a and settlement c, excluded. Only b, Flachgrab 14, is selected; its double burial remains one grave record.
- Catalogue 40 contains a first stone-cist description and explicit b wooden chamber. The first description has no printed a label. The two structures are separate records; their individuals are not separate graves.
- Catalogue 53 explicitly rejects a prior report of east–west orientation. That orientation must not be extracted as a supported attribute. Its earlier place-name is Ostingersleben.

Other excluded entries before the endpoint: 1, 2, 4–7, 11–13, 15–16, 19–20, 22–24, 27, 31–39, 41, 43–50, 52, 54, 56–60. Their source classifications are EF, EvS, EvG, vG, settlement, or explicitly uncertain flat-grave interpretations. Tangeln was formerly published under Ristedt; this alias was included in overlap checking.

## Parsed-source limitation

PDF page 2 places catalogue entries 5–9 before entries 1–4 in parsed Markdown. Thus two of the first five selected records, 8 and 9, appear before source-first record 3 in the supplied text. Pages 3 and 4 interleave adjacent columns; catalogue 29b and 40b continuations can appear before their headings. The manifest follows original PDF column/catalogue order. It cannot establish that supplied Markdown has faithful reading order, and a model reading only canonical text may reasonably follow that defective sequence. Attribute associations around those spans need original-source checking. No parser changes were made.

The printed page 92 introduction establishes centimetres for measurements; explicit local m or g units override the general convention. Unknowns and qualified numeric measurements remain null under the frozen extraction instruction. This manifest does not label any extracted attributes.

## Prior record overlap

All twelve prior claim files were inspected: six `claims.json` files (**164 claims**) and six `claims_extracted.json` files (**360 claims**), **524 entries total**. Identifier search used each claim value and scalar context, excluding label notes and bibliography. It case-folded, removed diacritics and checked source site names plus known aliases: Havelberg, Heidberg, Leetze, Bertkow, Plätz, Hindenburg, Tangeln, Ristedt, Thüritz, Grassau, Peulingen, Sanne, Schinne, Tangermünde, Estedt, Menz, Dornburg, Ackendorf, Eimersleben, Ostingersleben, Emden, Haldensleben and Neuhaldensleben. A matching bare grave number would not establish identity.

One site-level hit was found: `final_dataset_3/dobes-1998-kugelamphoren-de/claims_extracted.json`, zero-based index **22**, resultPath **records[30].site**, names **Menz**. The prior source `document.md` page 35 discusses Menz tumulus finds and page 40 Menz stratigraphy; this is substantive prior entity exposure, not merely a bibliography citation. The prior claim contains no grave/substructure identifier, so exact identity with Beier 40 stone cist versus 40b wooden chamber is unresolved. Both selected Menz records are potentially overlapping. The complete Beier family is therefore transfer-only, not untouched holdout.

No selected-site/known-alias hits occurred in the other **523** claim entries. This is no identified overlap for the other **18** selected records within these prior claim files, not proof about hidden records, all prior source prose, training data or unrecorded aliases.

| Prior family | claims.json | claims_extracted.json |
|---|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 25 | 60 |
| buchvaldek-koutecky-1972-vikletice-de | 26 | 60 |
| conrad-2011-bbc-graves-de | 31 | 60 |
| dobes-1998-kugelamphoren-de | 25 | 60 |
| durankulak-catalogue-de | 30 | 60 |
| shbat-2009-skeletal-health-en | 27 | 60 |

The initial prior-source consultation distinguished the Menz hit from bibliography-only coincidence. The extended full-text audit below supersedes that narrower scope. No earlier labels were copied into the new source artifacts.

## Extended audit of all six prior full source texts

The extended audit searched the complete supplied `document.md` texts of all six prior families: `buchvaldek-1970-vikletice-tables-de`, `buchvaldek-koutecky-1972-vikletice-de`, `conrad-2011-bbc-graves-de`, `dobes-1998-kugelamphoren-de`, `durankulak-catalogue-de` and `shbat-2009-skeletal-health-en`. Search terms were selected manifest sites, municipalities and the aliases listed above. Checks included whole-word case-folded matching, diacritic removal, German ae/oe/ue variants, whitespace normalization and joining line-ending hyphenation. Candidate matches were read in context. Source page references below are one-based `FREE:PAGE` markers; line references are one-based lines in the prior markdown. This extends the earlier 524-claim audit; it does not inspect holdout model outputs or claim-support judgments.

| Prior source location | Selected source identity | Assessment |
|---|---|---|
| Dobeš page 28, line 971 | Beier catalogue 30, Estedt Fdpl. 2, inventory item 2 | **Confirmed substantive same-record exposure.** The prose uses Estedt as a morphological comparison and cites Beier 1988 Taf. 6,7. Selected catalogue 30 explicitly assigns Taf. 6,7 to its second vessel. This is a specific grave-good attribute/illustration link, beyond a bibliographic mention; it does not mean that Dobeš reproduces the whole grave record or that an earlier evaluated claim targeted this vessel. |
| Dobeš page 35, line 1114 | Beier catalogue 40 Menz, mound/cist complex | Substantive mound-burial comparison, naming Menz alongside Stobra. The passage lacks a subgrave identifier. |
| Dobeš page 40, line 1174 | Beier catalogue 40 Menz, first stone-cist mound record | **Strong source-record match.** The stated sequence Walternienburg before KAK before Schönfeld, with Lies 1955 p.132, aligns with the selected stone-cist mound's underlying Walternienburg occupation and later Schönfeld relationship. The wooden chamber 40b lies 15 m west and is not separately described here. This strengthens the cist match while the prior claim's subgrave identity remains unresolved. |
| Dobeš page 40, line 1174; page 41, line 1185 | Tangermünde site; selected 29b is Flachgrab 14 | Substantive site/cemetery context, **not a confirmed selected-grave match**. The first passage concerns a KAK pit near Havelland graves and is more compatible with excluded settlement context 29c; neither passage names Grab 14 or its defining contents. Do not count this as demonstrated 29b overlap. |
| Dobeš page 46, line 1444; page 47, line 1613 | Menz; Tangermünde | Bibliography entries only; these hits alone are not record evidence. |

All other normalized-name matches were false positives caused by removing the umlaut from **Plätz**, producing the common German noun *Platz*. The three hits in Buchvaldek 1970 (pages 42, 47, 49; lines 1037, 1110, 1142), two in Buchvaldek–Koutecky 1972 (pages 23, 25; lines 323, 347), and one in Durankulak (page 6, line 539) concern ordinary place/position words, not Bertkow/Plätz. Conrad and Shbat had no selected-name hits. No other selected site/known alias matched in the six full texts.

The family remains **transfer-only**. The extended evidence identifies one precise selected record via its illustrated object (Estedt 30), a strong selected mound/cist match (Menz 40), and unresolved possible exposure of Menz 40b. Tangermünde is retained as site-level exposure without a confirmed selected-grave match. Counts of prior evaluated labels and counts of prior source-record exposure are different; the new source-text finding must not be described as an additional labeled evaluation example.

Limits remain: this search cannot rule out damaged OCR, unidentified aliases, translated historical names or descriptions that omit place names. It covers all six supplied prior full markdown texts, not inaccessible documents or training data.
