# final_dataset_3 — gold evidence-grounding labels

Each document directory holds a hand-written `schema.json` (a realistic researcher
extraction schema) and `claims.json` (typed extracted values with gold evidence
anchors). Values are authored the way an extractor would emit them for the typed
field (numbers for measurements with the unit in the field name, ISO dates,
booleans), not by copying the document string.

Unsupported claims (`goldAnchorIds: []`) come in three kinds, named in each note:

- **(a)** the value is never stated in the document (plausible hallucination,
  off-by-one, wrong measurement);
- **(b)** the value *does* occur in the document but under a different meaning
  (another grave's depth, a cited work's year, a construction length read as a
  depth);
- **(c)** the value follows only by computation or paraphrase (a sum, a count, a
  derived ratio or percentage), so no single anchor states it.

## Counts

| Document | Claims | Supported | Unsupported | (a) never stated | (b) wrong meaning | (c) computed |
|---|---|---|---|---|---|---|
| conrad-2011-bbc-graves-de | 31 | 23 | 8 (26%) | 3 | 3 | 2 |
| durankulak-catalogue-de | 30 | 22 | 8 (27%) | 3 | 3 | 2 |
| shbat-2009-skeletal-health-en | 27 | 19 | 8 (30%) | 3 | 3 | 2 |
| buchvaldek-koutecky-1972-vikletice-de | 26 | 18 | 8 (31%) | 3 | 3 | 2 |
| dobes-1998-kugelamphoren-de | 25 | 17 | 8 (32%) | 3 | 3 | 2 |
| buchvaldek-1970-vikletice-tables-de | 25 | 17 | 8 (32%) | 3 | 3 | 2 |
| **total** | **164** | **116** | **48 (29%)** | **18** | **18** | **12** |

Every claim value is a scalar (string, number, boolean). A schema field that is
a list gets one claim per element, with the element index as the last step of
`resultPath` (e.g. `["ware_classes", 0, "count"]`, `["authors", 2]`). The four
documents labelled before that rule was introduced were expanded mechanically
from their list-valued claims, which is why their claim counts run above 25 and
their unsupported share dips to 26-31%; the unsupported claims themselves were
not touched. Say the word and I will trim those four back inside 20-25 with the
~30% split restored.

Validated: every `goldAnchorId` exists in the document's `anchors.json`, every
`resultPath` is consistent with the document's `schema.json`, and every
unsupported note names its kind.

## Per document

### conrad-2011-bbc-graves-de (16 pages, 381 anchors, all `text`)

Bell Beaker grave catalogue (Fundliste + "7.3 Katalog Neufunde"). Schema is
document-level metadata plus `records` of graves keyed by site/site code/grave
id. Feature measurements are metres (stated explicitly on p3), so
`grave_pit_length_m` / `_width_m` / `_depth_m` take metre values (`T ca. 0,1` ->
`0.1`). Claims span p1 (Fundliste entries), p2 (section intro), p3-p7 (Kölsa),
p9-p10 (Grebehna, Löbnitz-Bennewitz, Markranstädt), p13-p16 (Zwenkau,
Großstorkwitz, Wehlitz).

Doubts:

- The excerpt carries **no title, author or year anywhere** — no cover page, no
  running head with a byline. The `author` and `year` claims are therefore
  unsupported by construction ((a) and (b) respectively); a labeller with the
  full volume would grade `author` differently.
- Grave entries repeat measurements in two plana (`Pl. 1` outline, `Pl. 2` with
  the burial). I always took the burial-bearing plan, and the notes say which.
- Anchor boundaries sometimes merge a grave's last inventory line with the
  culture attribution, and split one grave across a page break (Markranstädt
  Grab 1); the Leichenbrand claim lists both anchors.

### durankulak-catalogue-de (58 pages, 3974 anchors)

Very regular prehistoric grave catalogue: one anchor per grave entry, of the form
`GRAB n <symbol> . 1 -<Planquadrat>; h-<depth>. ... Orient. X; Frau/Mann, Ad. n
Jahre.` Schema mirrors that: `depth_m` (from `h-`), stone-construction length and
width (from `1,40 × 0,65`), body position, orientation, sex, age class and
bounds, cenotaph flag, culture. Claims are spread over p2, p6, p9, p15, p25, p31,
p42, p47, p49, p54 and p58.

Doubts:

- OCR damage in age ranges: Grab 2 reads `Ad. 4045 Jahre` (almost certainly
  40-45). I avoided claiming an age bound from it.
- Grab 300 is split by the parser: the heading `GRAB 300 a . 1` is one anchor and
  the body (`-30E1-4; h-0,95 ...`) another, in reverse reading order. The gold for
  the depth is the body anchor only, since the heading states no value.
- `h-` is read throughout as the grave depth. That is the catalogue's convention
  but is never spelled out in the excerpt, so an extremely strict reviewer could
  call every `depth_m` claim an inference.
- The stone-construction `a × b` pairs are the richest trap in this document and
  supply two of the (b) unsupported claims.

### shbat-2009-skeletal-health-en (21 pages, 864 anchors, 637 table cells)

English journal article. Schema is bibliographic metadata plus study-level
statistics, a `sites` array (Table 1) and a `pathology_cases` array (Tables 8 and
9). Claims cover the JSTOR cover page, the abstract, MATERIAL/METHODS, the
results text (p6) and five different tables (p4, p5, p7, p9, p11, p12).

Doubts:

- Numeric table cells are context-free anchors (`257`, `150`, `16`, `4.29`). They
  genuinely carry the value, so I list them alongside the prose statement, but
  they only *mean* anything with the row and column headers, which live in
  separate anchors. If the intended standard is "the anchor alone must be
  sufficient", these extra cell ids should be dropped.
- `150` appears twice in the Vikletice row of Table 1 (Amount and CWC). Only the
  Amount cell is listed for `sites[0].n_individuals`.
- Prose and table disagree in precision (`167.83` vs `167.8300`, `61.82` vs
  `61.82111`). I authored the rounded value the prose states and listed both
  anchors.
- The volume is printed as `Vol. 47` on p1 and as `XLVII/3` on p2; I avoided a
  volume claim rather than decide whether a Roman numeral counts as evidence.

### buchvaldek-koutecky-1972-vikletice-de (39 pages, 752 anchors)

German study of the Corded Ware cemetery of Vikletice with a Czech parallel title
and a grave list in the Anhang. Schema covers bibliographic fields, cemetery-level
counts, a `ceramic_types` array (the ware table on p6) and `records` of graves
with `pit_length_cm`, `pit_width_cm` and `pit_floor_area_m2`. Claims run from the
masthead (p1) through the statistics tables (p6, p12), the series discussion
(p15) and the appendix grave list (p35-p37) to the translator credit (p38).

Doubts:

- The Serie 1a appendix is parsed as **two enormous table cells**, each holding
  ~20 grave entries. The gold for `Gr. 5/1963` is that whole cell; a reviewer
  matching at anchor granularity gets a very coarse hit.
- The Abb. 7a value table (p12) merges minimum, median, maximum and the 80% range
  into a single cell (`123 160 195 144-184`); the labels `Minimum Median Maximum
  ...` sit in a different cell. The median claim's gold is the value cell only.
- Heavy OCR noise in the appendix (`m!` for `m2`, `SL` for `SI`, `170 x HO cm`). I
  only claimed graves whose digits are unambiguous.
- The masthead gives the year as `ROČNÍK LXIII 1972`; I claimed the Arabic 1972
  and skipped a volume claim on the Roman `LXIII`.

### dobes-1998-kugelamphoren-de (48 pages, 887 anchors)

German study of Globular Amphora culture (KAK) graves in north-west Bohemia,
published in the series *Saarbrücker Studien und Materialien zur Altertumskunde*.
The schema splits into study-level fields (bibliography, region, ware shares in
percent, amphora height range), a `records` array of grave find-spots
(site/district, discovery date, orientation, grave-pit length/width/depth in cm,
repository) and a `grave_goods` array of individual finds (vessel type, `height_cm`,
`rim_diameter_cm`, `max_width_cm`, `weight_g`). Vessel and grave measurements are
written out in cm on every entry; the abbreviation footnote on p3 expands the
labels (`H. = Höhe`, `Mdm. = Mündungsdurchmesser`, `Bdm. = Bodendurchmesser`,
`B. = Breite`, `L. = Länge`) but does not itself state a unit.
Claims are spread over p1-p2 (imprint, title, byline), the Fundliste entries on
p2-p20 (Běšice, Blšany, Bohušovice, Brozany, Hrdlovka, Prosmyky, Nová Ves,
Předměřice, Velvary, Žalov) and the analysis on p28-p29 and p35.

Doubts:

- **Tabelle 1 (p34) is badly parsed**: almost every count cell is empty and the
  surviving numbers (`24`, `10`, `100`, `8`, `13`, `19`, `31`) are detached from
  their columns, so column assignment is unrecoverable from the anchors. I based
  every ware-share claim on the prose in section 3.1 instead and used no numeric
  cell from that table as gold. A labeller with the page image would probably add
  those cells to the 31% claim.
- The title anchor contains the title **twice** (`Gräber der Kugelamphorenkultur
  in Nordwestböhmen Gräber der Kugelamphorenkultur in Nordwestböhmen`), an OCR
  duplication of the running head; the claimed value is the single title.
- The half-title (p1) prints the series year span as `1997/98` while the imprint
  reads `BONN 1998`. I claimed 1998 from the imprint and did not touch `1997/98`.
- Section 3.1.5 gives the dish share twice ("7% für ganz Böhmen", "bei Einschluß
  einer Schüssel ... mit 10%"). I claimed neither, to avoid a value whose scope is
  ambiguous; the (c) unsupported claim sums 23% + 7% deliberately.
- Heavy OCR speckle in the Fundliste (stray anchors holding only `'`, `■`, `·S'`,
  `A.-'Z`), and several `Fundstelle`/`Beigaben` labels come out as `Fundstelle'.`
  or `Beigaben'.`. None of these carry values, so they are not used as gold.
- Two graves are only doubtfully graves at all (Hrdlovka is possibly a sacrificial
  pit, Lovosice may be two disturbed graves). I claimed only measurements from
  them, never a "grave" classification.

### buchvaldek-1970-vikletice-tables-de (68 pages, 9906 anchors, 9592 table cells)

The tables volume of the 1970 Vikletice cemetery publication: grave and burial
statistics, then Tabelle 1 (pottery, ~22 pages), Tabelle 2-6 (hammer axes, mace
heads, three axe types), Tabelle 8-10b (whetstones, bone tools, animal-tooth
ornaments, copper jewellery). The schema is study-level counts plus three
arrays: `ware_classes` (the p6 ware table), `vessels` (Tabelle 1 rows) and
`finds` (every non-ceramic object table, with a `find_class` discriminator).
Feature and object measurements are millimetres, stated as "Maße in mm." under
each table's Erläuterungen; grave lengths on p2 are centimetres. 13 of the 17
supported claims are single table cells carried by a `context` string with the
sibling values (grave, item number, type, accession number). Pages covered: 1,
2, 3, 6, 15, 29, 35, 36, 39, 63, 64, 65.

Doubts:

- **Numeric cells are context-free anchors.** A gold cell here is literally
  `510`, `364`, `83` or `2150 gr`; the grave number, the column header and the
  table caption all live in separate anchors. Every such claim carries its
  siblings in `context`, but if the intended standard is "the anchor alone must
  identify the value", most of this document's supported claims would fail it.
- **Column drift from OCR.** Several Tabelle 1 header cells are garbage
  (`8 Ü` for Glimmeranteil, `Sehr. Z. !` for Scherbenzahl, `Ž <5` / `Ž m` for the
  two number columns on p15, `N` for Zw. Nr. on p29), and rows with an empty cell
  shift the remaining cells left (e.g. the 130/1963 row of Tabelle 3). I only
  claimed cells from rows whose full markdown row I could align column-by-column
  against the printed header.
- **Digit-level OCR damage.** `l` for `1` is pervasive in the measurement columns
  (`rl40`, `rl80`, `mllO`, `1X1280`, `nox 119`). I avoided every cell containing a
  letter inside a number; the claimed cells are clean digit strings.
- **The ware table on p6 lost its labels**: the first nine type names are merged
  into one cell (`A - Amphoren B - Becher C - Krüge ...`), so the `154 Stück`
  cell has no row label of its own and the A-class attribution rests on row
  position. That is the weakest of the supported claims here.
- Grave identifiers are inconsistent between tables: Tabelle 1 prints the bare
  number under a `Jahr 1963:` banner row, while Tabelle 2-10 print `120/1963`.
  Claim values and contexts use the full `number/year` form throughout.
- Tabelle 7 (p59) and Tabelle 1a/6a exist but are too damaged to align; nothing
  is claimed from them.

## Documents not labelled

`dobes-1998-kugelamphoren-de` arrived during labelling and is included above.

`buchvaldek-1970-vikletice-tables-de` arrived last and is included above. All six
documents in `final_dataset_3` are now labelled.


## Extractor-output labels (`claims_extracted.json`, 2026-09-04)

A second label set per document, made the way the README's steps 3-5 now
require: the real extractor (`qwen3.8:latest`, local Ollama, every prompt cut
to 16k tokens by the server, see [`../RAW_EXTRACTION_BLIND.md`](../RAW_EXTRACTION_BLIND.md))
was run with each document's `schema.json`; `raw_claims --sheet --sample 60`
drew a seeded sample of 60 emitted leaves per document, typed as emitted, with
the record's other scalars as `context`; six labelers, one per document, each
allowed to read only that document's `document.md`, `anchors.json`,
`schema.json` and the sheet, filled `goldAnchorIds` and a kind-tagged note.
Their notes are in each `<doc>/labeling_notes.md`. `expectedLexicalHitIds`
were filled mechanically afterwards.

| document | supported | unsupported | (a) never stated | (b) other meaning | (c) computed | multi-gold | unsupported present in text |
|---|---:|---:|---:|---:|---:|---:|---:|
| buchvaldek-1970-vikletice-tables-de | 59 | 1 | 0 | 1 | 0 | 6 | 1/1 |
| buchvaldek-koutecky-1972-vikletice-de | 1 | 59 | 28 | 31 | 0 | 1 | 31/59 |
| conrad-2011-bbc-graves-de | 47 | 13 | 1 | 5 | 7 | 7 | 5/13 |
| dobes-1998-kugelamphoren-de | 34 | 26 | 1 | 23 | 2 | 11 | 15/26 |
| durankulak-catalogue-de | 58 | 2 | 0 | 2 | 0 | 2 | 2/2 |
| shbat-2009-skeletal-health-en | 57 | 3 | 0 | 1 | 2 | 18 | 2/3 |
| **total** | **256** | **104** | **30** | **63** | **11** | **45** | **56/104** |

What the extractor did to the distribution: `buchvaldek-koutecky` ran past
its output limit into a runaway enumeration of amphora type codes (A26a …
A49z, none in the document), so 59 of its 60 sampled values are invented
records; `dobes` harvested place names from the analysis chapters and the
bibliography as `records[i].site`, so 23 of its values are (b); the other four
documents are 78-98% supported. `label_review --claims claims_extracted.json`
fails `conrad-2011` on the abstention rule (5 of 13 unsupported values occur
in the text; 7 are composed `grave_goods` labels, kind (c)).

Labeler conventions that a stricter reading would flip (each named in the
notes with the sheet indices): table captions accepted as evidence for a
row's class word (`buchvaldek-1970`, 19 claims; `shbat`, 10 claims: table
membership and site group headers); a value the extractor joined from two
cells of one row labeled supported with both anchors (`buchvaldek-1970`, 5);
range endpoints for `age_min`/`age_max`/`page_start` labeled supported
(`durankulak` 4, `shbat` 1); legend abbreviations expanded to the typed form
(`durankulak`: Mann → Male, Mat. → Mature). Values whose only occurrence is
inside a cited title in the bibliography are (b) (`dobes`, 9, five with
DOUBT). `conrad`: objects the catalogue files under "Funde" rather than
"Beigaben" are (b) for `grave_goods` (4, DOUBT).

Two document-level defects the labelers found: `durankulak` lettered graves
(1117A, 1194 A) lose their letter in the extractor's `grave_number`, colliding
with the unlettered grave; `shbat` copies the document's own cross-table
inconsistencies in grave numbers (Ao 769: 5/63 vs 5/53).
