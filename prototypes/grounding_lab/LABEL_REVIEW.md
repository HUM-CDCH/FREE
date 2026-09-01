# Label review

Generated 2026-09-01 by `pnpm --filter grounding-lab label-review` — do not hand-edit.

## 1790-06-17-1 — 5 claims

### `Jean`  (single)
- path: `['records', 0, 'person_name']`
- note: OCR-noise document; unique containment
- gold `anchor_ebb61fca35b` (p1): chaux Il aft détenu à la geole du Fort Royal le negre Jean, à m.me André, ayant un trou dans la joue, petite taille, ci devant à M. Havre du Lamentin.Le negre Marcel, à M. Sarfel au Simon. Crifpin à M. Emelot à St Pierre. Dauphin, à M. Edmond au Prêcheur. Filix à M. Magdallan, Edouard à M.Duval au à St Pierre. Carbet. - Un petit negre ne fachant dire ni fon nom ni celui de fon maître, ayant une mauvaise chemise blanche fur le corps. Joseph à M. St- Omer, au Carbet. Louis à M. du Buc Ramville, au Robert. Edouard à M. Laju, au Carbet.
- containment hits: `anchor_ebb61fca35b`

### `Marcel`  (single)
- path: `['records', 1, 'person_name']`
- note: same block as Jean — both notices OCR'd into one paragraph
- gold `anchor_ebb61fca35b` (p1): chaux Il aft détenu à la geole du Fort Royal le negre Jean, à m.me André, ayant un trou dans la joue, petite taille, ci devant à M. Havre du Lamentin.Le negre Marcel, à M. Sarfel au Simon. Crifpin à M. Emelot à St Pierre. Dauphin, à M. Edmond au Prêcheur. Filix à M. Magdallan, Edouard à M.Duval au à St Pierre. Carbet. - Un petit negre ne fachant dire ni fon nom ni celui de fon maître, ayant une mauvaise chemise blanche fur le corps. Joseph à M. St- Omer, au Carbet. Louis à M. du Buc Ramville, au Robert. Edouard à M. Laju, au Carbet.
- containment hits: `anchor_ebb61fca35b`

### `environ 25 ans`  (single)
- path: `['records', 2, 'person_age']`
- note: unique, second notice block
- gold `anchor_49c796ee55f` (p1): Ét à celle de St Pierre , le negre Moko d'environ 25 ans, de 5 p. 1 p. ayant des marques de coup de fouet fur le côté droit, chemise & culotte de toile grise, à M. Lallemand, au Fort Royal. Le mulâtre Pascal, créole, de la Trinité, d'environ 30 ans, de p. chemise & culotte de toile lanche , à M. Lamontagne à Ste Marie. Le negre J. Pierre, Sofo, un collier au cou & une chaîne qui lúi entoure le corps, à M. Solliers.
- containment hits: `anchor_49c796ee55f`

### `Lallemand`  (single)
- path: `['records', 2, 'owner_name']`
- note: unique
- gold `anchor_49c796ee55f` (p1): Ét à celle de St Pierre , le negre Moko d'environ 25 ans, de 5 p. 1 p. ayant des marques de coup de fouet fur le côté droit, chemise & culotte de toile grise, à M. Lallemand, au Fort Royal. Le mulâtre Pascal, créole, de la Trinité, d'environ 30 ans, de p. chemise & culotte de toile lanche , à M. Lamontagne à Ste Marie. Le negre J. Pierre, Sofo, un collier au cou & une chaîne qui lúi entoure le corps, à M. Solliers.
- containment hits: `anchor_49c796ee55f`

### `New Orleans`  (ABSTAIN)
- path: `['records', 0, 'location']`
- note: not in document — must abstain
- containment hits (must be empty): none


## age-related-disease — 20 claims

### `Age-related disease or disease-related age? Perspectives for paleopathological research`  (single)
- path: `['title']`
- note: title anchor
- gold `anchor_de57395d0c4` (p1): Age-related disease or disease-related age? Perspectives for paleopathological research
- containment hits: `anchor_de57395d0c4`

### `Katharina Fuchs`  (MULTI-GOLD)
- path: `['authors', 0]`
- note: REVIEW multi-gold: author list + first-authorship note + CRediT statement
- gold `anchor_233d1ab87aa` (p1): Katharina Fuchs a,*,1 , Jo Appleby b,1 , Marie Louise Schjellerup J ø rkov c , George R. Milner d , Niels Lynnerup e , Katherine D. van Schaik f,g , Julia Gresky h , Fabian Crespo i,j , Molly Zuckerman k,l,m , Kathryn E. Marklein i,j
- gold `anchor_81a0115d030` (p1): 1 First Authorship shared by Katharina Fuchs and Jo Appleby
- gold `anchor_d8215394f36` (p8): Kathryn E. Marklein: Writing -review & editing, Writing -original draft, Investigation. Molly Zuckerman: Writing -review & editing, Writing -original draft, Investigation. Marie Louise Schjellerup J ø rkov: Writing -review & editing, Investigation, Conceptualization. George R. Milner: Writing -review & editing, Writing -original draft, Investigation. Katharina Fuchs: Writing -review & editing, Writing -original draft, Project administration, Investigation, Funding acquisi­ tion, Conceptualization. Jo Appleby: Writing -review & editing, Writing -original draft, Investigation, Conceptualization. Julia Gresky: Writing -review & editing, Writing -original draft, Investigation. Fabian Crespo: Writing -review & editing, Writing -original draft, Investigation. Niels Lynnerup: Writing -review & editing, Writing -original draft, Investigation. Katherine van Schaik: Writing -review & editing, Writing -original draft, Investigation.
- containment hits: `anchor_233d1ab87aa`, `anchor_81a0115d030`, `anchor_d8215394f36`

### `Jo Appleby`  (MULTI-GOLD)
- path: `['authors', 1]`
- note: REVIEW multi-gold: author list + first-authorship note + CRediT statement
- gold `anchor_233d1ab87aa` (p1): Katharina Fuchs a,*,1 , Jo Appleby b,1 , Marie Louise Schjellerup J ø rkov c , George R. Milner d , Niels Lynnerup e , Katherine D. van Schaik f,g , Julia Gresky h , Fabian Crespo i,j , Molly Zuckerman k,l,m , Kathryn E. Marklein i,j
- gold `anchor_81a0115d030` (p1): 1 First Authorship shared by Katharina Fuchs and Jo Appleby
- gold `anchor_d8215394f36` (p8): Kathryn E. Marklein: Writing -review & editing, Writing -original draft, Investigation. Molly Zuckerman: Writing -review & editing, Writing -original draft, Investigation. Marie Louise Schjellerup J ø rkov: Writing -review & editing, Investigation, Conceptualization. George R. Milner: Writing -review & editing, Writing -original draft, Investigation. Katharina Fuchs: Writing -review & editing, Writing -original draft, Project administration, Investigation, Funding acquisi­ tion, Conceptualization. Jo Appleby: Writing -review & editing, Writing -original draft, Investigation, Conceptualization. Julia Gresky: Writing -review & editing, Writing -original draft, Investigation. Fabian Crespo: Writing -review & editing, Writing -original draft, Investigation. Niels Lynnerup: Writing -review & editing, Writing -original draft, Investigation. Katherine van Schaik: Writing -review & editing, Writing -original draft, Investigation.
- containment hits: `anchor_233d1ab87aa`, `anchor_81a0115d030`, `anchor_d8215394f36`

### `10.1016/j.ijpp.2026.02.003`  (single)
- path: `['doi']`
- note: unique, doi line p1
- gold `anchor_6adfba012ee` (p1): https://doi.org/10.1016/j.ijpp.2026.02.003
- containment hits: `anchor_6adfba012ee`

### `k.fuchs@ufg.uni-kiel.de`  (single)
- path: `['corresponding_email']`
- note: unique p1
- gold `anchor_fdffe173700` (p1): E-mail addresses: k.fuchs@ufg.uni-kiel.de (K. Fuchs), ja253@leicester.ac.uk (J. Appleby), mljorkov@sund.ku.dk (M.L.S. J ø rkov), ost@psu.edu (G.R. Milner), nly@ sund.ku.dk (N. Lynnerup), katherine.d.van.schaik@vumc.org (K.D. van Schaik), Julia.Gresky@dainst.de (J. Gresky), fabian.crespo@louisville.edu (F. Crespo), mzuckerman@anthro.msstate.edu (M. Zuckerman), kathryn.marklein@louisville.edu (K.E. Marklein).
- containment hits: `anchor_fdffe173700`

### `University of Leicester`  (single)
- path: `['affiliations', 0]`
- note: affiliation b
- gold `anchor_028b35c6855` (p1): b School of Archaeology and Ancient History, University of Leicester, University Road, Leicester LE1 7RH, United Kingdom
- containment hits: `anchor_028b35c6855`

### `Kiel University`  (single)
- path: `['affiliations', 1]`
- note: affiliation a; acknowledgments also mention Kiel University (anchor_c3eb2c0cdf3) but as funding host, not an author affiliation
- gold `anchor_1eeb7fa3207` (p1): a Institute of Prehistoric and Protohistoric Archaeology, Kiel University, Johanna-Mestorf-Str. 2 -6, Kiel 24118, Germany
- containment hits: `anchor_1eeb7fa3207`, `anchor_c3eb2c0cdf3`

### `Vanderbilt University Medical Center`  (single)
- path: `['affiliations', 2]`
- note: affiliation f
- gold `anchor_f51c592e3bd` (p1): f Department of Radiology and Radiological Sciences, Vanderbilt University Medical Center, 1211 Medical Center Drive, Nashville, TN 37232, United States
- containment hits: `anchor_f51c592e3bd`

### `Mississippi State University`  (MULTI-GOLD)
- path: `['affiliations', 3]`
- note: REVIEW multi-gold: affiliations k and l
- gold `anchor_78e15c3560d` (p1): k Cobb Institute of Archaeology, Mississippi State University, Mississippi State, MS 39762, United States
- gold `anchor_60e37591ea7` (p1): l Department of Anthropology and Middle Eastern Cultures, Mississippi State University, Mississippi State, MS 39762, United States
- containment hits: `anchor_78e15c3560d`, `anchor_60e37591ea7`

### `60 %`  (single)
- path: `['mays_variation_share']`
- note: Mays 2015 figure p3
- gold `anchor_4ab699d3e12` (p3): narrow age estimation ranges is a serious methodological issue. Mays (2015) notes that for a given skeletal assemblage, approximately 60 % of variation in adult skeletal age markers can be caused by factors other than age. Perhaps the most notable disease process involved in this variation is osteoarthritis (e.g., Calce et al., 2018; and see Section 3.4). On a more systemic scale, other factors such as vitamin D deficiency and concentrations of circulating sex steroid hormones are also influential, which may have implications for bone remodeling in individuals with these diseases. In fact, any condition affecting bone remodeling or cartilage ossification may also affect at least some age estimation methods (Mays, 2015). While the multifaceted aetiologies of the morphology of entheses, crucial for some aging methods such as Tran­ sition Analysis 3 (TA3, Milner et al., 2019) are recognized, the influence of pathogenic factors (e.g., collagen malformation, ruptures, inflam­ mation) is typically difficult to grasp and operationalize in an age-related context.
- containment hits: `anchor_4ab699d3e12`

### `TA3`  (MULTI-GOLD)
- path: `['age_estimation_technique']`
- note: REVIEW multi-gold: recommendation section + entheses paragraph + TA3 trait-manual reference
- gold `anchor_efadde47e89` (p7): Techniques such as TA3 (Milner et al., 2019) take a holistic approach to offer more accurate age-at-death estimations across populations (although validation studies have yet to be undertaken on skeletal col­ lections different from those used when developing the method). Keeping in mind that age estimates are affected by the relationship be­ tween age and disease, the inclusion in the TA3 reference sample of individuals, regardless of their life histories, renders confidence in­ tervals longer than if we could adequately control for life (including disease) variables. As a large number of skeletal markers are included in the TA3 assessment the technique appears promising for disparate skeletal assemblages and, even for commingled and disarticulated skeletal remains (Bolster et al., 2024; Getz, 2020). Further research into the mechanisms underlying the skeletal features included within TA3 might allow refinement of the method and an associated reduction in confidence intervals.
- gold `anchor_4ab699d3e12` (p3): narrow age estimation ranges is a serious methodological issue. Mays (2015) notes that for a given skeletal assemblage, approximately 60 % of variation in adult skeletal age markers can be caused by factors other than age. Perhaps the most notable disease process involved in this variation is osteoarthritis (e.g., Calce et al., 2018; and see Section 3.4). On a more systemic scale, other factors such as vitamin D deficiency and concentrations of circulating sex steroid hormones are also influential, which may have implications for bone remodeling in individuals with these diseases. In fact, any condition affecting bone remodeling or cartilage ossification may also affect at least some age estimation methods (Mays, 2015). While the multifaceted aetiologies of the morphology of entheses, crucial for some aging methods such as Tran­ sition Analysis 3 (TA3, Milner et al., 2019) are recognized, the influence of pathogenic factors (e.g., collagen malformation, ruptures, inflam­ mation) is typically difficult to grasp and operationalize in an age-related context.
- gold `anchor_e55003c01d7` (p10): Milner, G.R., Ousley, S.D., Boldsen, J.L., Getz, S.M., Weise, S., Tarp, P., 2019. Transition Analysis 3 (TA3) trait manual. Public Distribution Version 1.0. https://www. statsmachine.net/software/TA3/docs/TA3_Trait_Scoring_Manual_1.0.pdf.
- containment hits: `anchor_4ab699d3e12`, `anchor_efadde47e89`, `anchor_e55003c01d7`

### `Kathryn E. Marklein`  (MULTI-GOLD)
- path: `['credit_authors', 0]`
- note: REVIEW multi-gold: CRediT statement + author list
- gold `anchor_d8215394f36` (p8): Kathryn E. Marklein: Writing -review & editing, Writing -original draft, Investigation. Molly Zuckerman: Writing -review & editing, Writing -original draft, Investigation. Marie Louise Schjellerup J ø rkov: Writing -review & editing, Investigation, Conceptualization. George R. Milner: Writing -review & editing, Writing -original draft, Investigation. Katharina Fuchs: Writing -review & editing, Writing -original draft, Project administration, Investigation, Funding acquisi­ tion, Conceptualization. Jo Appleby: Writing -review & editing, Writing -original draft, Investigation, Conceptualization. Julia Gresky: Writing -review & editing, Writing -original draft, Investigation. Fabian Crespo: Writing -review & editing, Writing -original draft, Investigation. Niels Lynnerup: Writing -review & editing, Writing -original draft, Investigation. Katherine van Schaik: Writing -review & editing, Writing -original draft, Investigation.
- gold `anchor_233d1ab87aa` (p1): Katharina Fuchs a,*,1 , Jo Appleby b,1 , Marie Louise Schjellerup J ø rkov c , George R. Milner d , Niels Lynnerup e , Katherine D. van Schaik f,g , Julia Gresky h , Fabian Crespo i,j , Molly Zuckerman k,l,m , Kathryn E. Marklein i,j
- containment hits: `anchor_233d1ab87aa`, `anchor_d8215394f36`

### `progeria`  (single)
- path: `['accelerated_aging_syndrome']`
- note: p5
- gold `anchor_f0fb6b5010c` (p5): Very rarely, a disease directly affects biological age by accelerating it. One example is the syndrome complex of progeria (Lessel and Kubisch, 2019), which causes rapid aging from the first year of life on­ wards until children die around the age of 15 years from a stroke or heart attack (Gordon et al., 2003). However, due to the diverse picture of the syndromes and their non-specific skeletal changes, like small stature, cranio-facial dysplasia (e.g., micrognathia), and osteoporosis, progeria is not easily detectable by macroscopic evaluation in archaeological human remains.
- containment hits: `anchor_f0fb6b5010c`

### `International Journal of Paleopathology`  (single)
- path: `['journal']`
- note: header p1
- gold `anchor_dcaf435b4d3` (p1): International Journal of Paleopathology
- containment hits: `anchor_dcaf435b4d3`

### `Im Dol 2-6`  (single)
- path: `['affiliations', 4, 'street']`
- note: gold text reads 'Im Dol 2 -6' (spaced dash) — deliberate paraphrase case, lexical must miss
- gold `anchor_773ccee8569` (p1): h Division of Natural Sciences, German Archaeological Institute, Im Dol 2 -6, Berlin, Germany
- containment hits: none

### `10.1016/j.ijpp.2026.02.004`  (ABSTAIN)
- path: `['doi']`
- note: ADVERSARIAL near-variant DOI; verified absent
- containment hits (must be empty): none

### `Katherine Fuchs`  (ABSTAIN)
- path: `['authors', 0]`
- note: ADVERSARIAL blend of Katharina Fuchs and Katherine D. van Schaik; verified absent
- containment hits (must be empty): none

### `TA4`  (ABSTAIN)
- path: `['age_estimation_technique']`
- note: ADVERSARIAL near-variant of TA3; verified absent
- containment hits (must be empty): none

### `University of Oxford`  (ABSTAIN)
- path: `['affiliations', 5]`
- note: plain absent affiliation
- containment hits (must be empty): none

### `Aarhus University`  (ABSTAIN)
- path: `['affiliations', 5]`
- note: plain absent affiliation
- containment hits (must be empty): none


## brondbylund — 17 claims

### `TAK 1506`  (MULTI-GOLD)
- path: `['journal_number']`
- note: REVIEW multi-gold: facts box + prose + title page all state the journal number
- gold `anchor_c16f6dfbfed` (p7): Kroppedal Museums journalnummer: TAK 1506 Slots- og Kulturstyrelsens j.nr: KS j.nr. 15/ 00153 Sted- og lokalitetsnummer: 020202 - 29.
- gold `anchor_74f5629f2e4` (p2): Udgravningen fik journalnummeret TAK 1506 og blev navngivet Brøndbylund 3 efter et gammelt stednavn og tidligere udgravninger i området syd for.
- gold `anchor_4be8009e760` (p1): TAK 1506 Bygherrerapport om den arkæologiske udgravning
- containment hits: `anchor_4be8009e760`, `anchor_74f5629f2e4`, `anchor_c16f6dfbfed`

### `Maria Lisette Jacobsen`  (MULTI-GOLD)
- path: `['report_author']`
- note: REVIEW multi-gold: byline + staff list
- gold `anchor_772d564bd37` (p1): Af Maria Lisette Jacobsen, arkæolog, Kroppedal Museum
- gold `anchor_8b51fb9a6d9` (p7): Museumsinspektør Maria Lisette Jacobsen (ansvarlig leder og beretningsansvarlig), museumsinspektør Lotte Reedtz Sparrevohn, museumsinspektør Jonas Hasemann Sigurdsson (daglig leder af prøvegravning), og museumstekniker Kenneth Paulmann og Jan Poulsen (GPS-opmåling).
- containment hits: `anchor_772d564bd37`, `anchor_8b51fb9a6d9`

### `542 g`  (single)
- path: `['records', 0, 'bone_weight']`
- note: unique, urn caption
- gold `anchor_b0152f15cb9` (p4): En af urnerne fra gravpladsen. Urnen indeholdt 542 g brændt knoglemateriale og har haft et låg af træ eller læder og øverst en flad sten En af urnerne fra gravpladsen. Urnen indeholdt 542 g brændt knoglemateriale og har haft et låg af træ eller læder og øverst en flad sten
- containment hits: `anchor_b0152f15cb9`

### `ca. 1 år`  (single)
- path: `['youngest_individual_age']`
- note: unique
- gold `anchor_3e88c36c6ac` (p5): De døde var mænd, kvinder og børn, hvoraf den yngste var ca. 1 år. På gravpladsen er de gravlagt på flere forskellige måder. Alle er kremeret, med undtagelse af den formodede noget yngre jordfæstegrav, hvor det eneste tilbageværende bevis på den afdøde var en smule ubrændt tandemalje.
- containment hits: `anchor_3e88c36c6ac`

### `900 e. Kr.`  (single)
- path: `['site_use_end']`
- note: unique, 'Frem til omkring år 900 e. Kr.'
- gold `anchor_e32d087632c` (p2): Frem til omkring år 900 e. Kr.; slutningen af ældre vikingetid, blev området benyttet af oldtidens mennesker. Herefter er beboerne formentlig flyttet nordpå, ind til den tidligste del af det nuværende Brøndbyøster.
- containment hits: `anchor_e32d087632c`

### `18`  (single)
- path: `['longhouse_count']`
- note: hard: bare number; source says 'mindst 18 treskibede langhuse'
- gold `anchor_735960dfc73` (p2): Ved udgravningen afdækkedes sporene af mindst 18 treskibede langhuse, to forrådshuse med hævet gulv; 'staklader' og flere delvise hegnsforløb. Bosættelsen strækker sig i tid fra bronzealder til vikingetid; et spænd på ca. 2000 år.
- containment hits: `anchor_735960dfc73`, `anchor_dbbc4c7a5fd`, `anchor_0318bfca7a2`, `anchor_21a801b4335`

### `Lars Nissen`  (single)
- path: `['metal_detectorist']`
- note: unique
- gold `anchor_edc60e8a2e9` (p7): Lars Nissen gik med metaldetektor.
- containment hits: `anchor_edc60e8a2e9`

### `Lind & Risør`  (single)
- path: `['contractor']`
- note: unique; '&' stripped by normalization
- gold `anchor_5cd63a98820` (p7): Gravemaskinen blev kørt af maskinfører Bo, Lind & Risør
- containment hits: `anchor_5cd63a98820`

### `FHM 4296/2382`  (single)
- path: `['science_report_number']`
- note: unique; slash-separated id, normalization test
- gold `anchor_76a638133bd` (p7): Foretaget af Afdeling for Konservering og Naturvidenskab på Moesgård Museum (rapport FHM 4296/2382) og Antropologisk Laboratorium, Retsmedicinsk Institut (rapport nr. AS 8/2017).
- containment hits: `anchor_76a638133bd`

### `Brøndbyøster sogn`  (single)
- path: `['parish']`
- note: unique, facts box
- gold `anchor_1449a8a3f1c` (p7): Brøndbylund 3. Brøndbyøster sogn, Smørum herred, Københavns amt.
- containment hits: `anchor_1449a8a3f1c`

### `5000 m2`  (ABSTAIN)
- path: `['excavated_area']`
- note: not in document — must abstain
- containment hits (must be empty): none

### `1200 f.Kr.`  (ABSTAIN)
- path: `['records', 0, 'dating']`
- note: not in document — must abstain
- containment hits (must be empty): none

### `TAK 1507`  (ABSTAIN)
- path: `['journal_number']`
- note: ADVERSARIAL: near-variant of present TAK 1506 — must abstain
- containment hits (must be empty): none

### `543 g`  (ABSTAIN)
- path: `['records', 0, 'bone_weight']`
- note: ADVERSARIAL: off-by-one of present 542 g — must abstain
- containment hits (must be empty): none

### `ca. 2 år`  (ABSTAIN)
- path: `['youngest_individual_age']`
- note: ADVERSARIAL: near-variant of present ca. 1 år — must abstain
- containment hits (must be empty): none

### `150`  (ABSTAIN)
- path: `['records', 0, 'grave_count']`
- note: ADVERSARIAL: substring trap: appears only inside longer numbers (3 anchors) — must abstain
- containment hits (must be empty): none

### `19`  (ABSTAIN)
- path: `['longhouse_count']`
- note: ADVERSARIAL: substring trap: appears only inside longer tokens — must abstain
- containment hits (must be empty): none


## catfish-collagen — 22 claims

### `Properties of Skin Collagen from Southern Catfish (Silurus meridionalis) Fed with Raw and Cooked Food`  (MULTI-GOLD)
- path: `['title']`
- note: REVIEW multi-gold: title + citation block
- gold `anchor_4b6b6143a77` (p1): Properties of Skin Collagen from Southern Catfish ( Silurus meridionalis ) Fed with Raw and Cooked Food
- gold `anchor_ac8808d5fad` (p1): Citation: Zhang, Q.; Hou, S.; Liu, Y.; Du, J.; Jia, Y.; Yang, Q.; Xu, T.; Takagi, Y.; Li, D.; Zhang, X. Properties of Skin Collagen from Southern Catfish ( Silurus meridionalis ) Fed with Raw and Cooked Food. Foods 2024 , 13 , 2901. https://doi.org/10.3390/ foods13182901
- containment hits: `anchor_4b6b6143a77`, `anchor_ac8808d5fad`

### `zhangxi@mail.hzau.edu.cn`  (single)
- path: `['corresponding_email']`
- note: unique p1
- gold `anchor_cd670a8ada5` (p1): Correspondence: zhangxi@mail.hzau.edu.cn; Tel.: +86-18672306015; Fax: +86-027-87282113
- containment hits: `anchor_cd670a8ada5`

### `+86-18672306015`  (single)
- path: `['corresponding_phone']`
- note: unique p1
- gold `anchor_cd670a8ada5` (p1): Correspondence: zhangxi@mail.hzau.edu.cn; Tel.: +86-18672306015; Fax: +86-027-87282113
- containment hits: `anchor_cd670a8ada5`

### `Carlos José Dias Pereira`  (single)
- path: `['academic_editor']`
- note: OCR reads 'Jos é' with split accent — lexical must miss, neural must catch
- gold `anchor_281439a9f96` (p1): Academic Editor: Carlos Jos é Dias Pereira
- containment hits: none

### `1 August 2024`  (single)
- path: `['received_date']`
- note: unique p1
- gold `anchor_f781e0cbbe1` (p1): Received: 1 August 2024
- containment hits: `anchor_f781e0cbbe1`

### `13 September 2024`  (single)
- path: `['published_date']`
- note: unique p1
- gold `anchor_2c556afc880` (p1): Published: 13 September 2024
- containment hits: `anchor_2c556afc880`

### `Hokkaido University`  (single)
- path: `['affiliations', 1]`
- note: affiliation 2
- gold `anchor_156d421e102` (p1): 2 Faculty of Fisheries Sciences, Hokkaido University, 3-1-1 Minato-cho, Hakodate 041-8611, Hokkaido, Japan; takagi@fish.hokudai.ac.jp
- containment hits: `anchor_156d421e102`

### `takagi@fish.hokudai.ac.jp`  (single)
- path: `['authors', 7, 'email']`
- note: in affiliation line
- gold `anchor_156d421e102` (p1): 2 Faculty of Fisheries Sciences, Hokkaido University, 3-1-1 Minato-cho, Hakodate 041-8611, Hokkaido, Japan; takagi@fish.hokudai.ac.jp
- containment hits: `anchor_156d421e102`

### `6 weeks`  (single)
- path: `['culture_period']`
- note: methods p3
- gold `anchor_7d5aa15172d` (p3): Southern catfish were cultivated in the indoor recirculating aquaculture experimental system in the College of Aquaculture, Huazhong Agricultural University, China, with a culture period of 6 weeks. During the culture period, southern catfish (6.18 ± 0.52 g, 9.30 ± 0.15 cm) were randomly divided into RF and CF groups, and 10 fish were set up in each group, and each group has 3 replicates. They were separately fed at 10% of their total weight with fresh grass carp ( Ctenopharyngodon idella ) meat or high temperature cooked grass carp meat, respectively, at 07:30 and 19:00.
- containment hits: `anchor_7d5aa15172d`

### `27.09 ± 0.89 g`  (single)
- path: `['rf_body_weight']`
- note: methods p3
- gold `anchor_a986c2a37ab` (p3): After completing the cultivation experiment, we randomly selected five fish from each group for analysis. The average body weights and lengths of the fish in the RF group were 27.09 ± 0.89 g and 14.42 ± 0.22 cm, and those of the fish in the CF group were 20.74 ± 0.48 g and 13.58 ± 0.25 cm. We anesthetized the fish using MS-222 (140 mg/L), collected skin samples, and temporarily stored them in liquid nitrogen. After all sampling was complete, we stored the samples at -20 ◦ C until used in subsequent experiments.
- containment hits: `anchor_a986c2a37ab`

### `8.66 ± 0.11%`  (MULTI-GOLD)
- path: `['rf_wet_extraction_rate']`
- note: REVIEW multi-gold: results p5 + abstract
- gold `anchor_b73a9b0ba0d` (p5): The yields of collagen from fish skin in the RF and CF groups are shown in Figure 1. The extraction rate based on wet tissue was 8.66 ± 0.11% in the RF group and 8.00 ± 0.27% in the CF group. The extraction rate based on dry weight was 20.53 ± 0.03% in the RF group and 18.68 ± 0.23% in the CF group. The RF group had a higher yield than that of the CF group in both cases. The wet weight extraction rate of southern catfish skin collagen was slightly lower than that of grass carp skin collagen (10.61 ± 0.67%), snapper skin collagen (13%), and tilapia ( Oreochromis niloticus ) skin collagen (27.2%), but higher than that of bigeye snapper skin (7.5%) [20-23]. The dry weight extraction rate was similar to that of black drum fish (18.1%), but lower than that of ocellate puffer fish skin (55.4%) and largefin longbarbel catfish skin (44.8%) [24,25].
- gold `anchor_8aa33654155` (p1): Abstract: The southern catfish ( Silurus meridionalis ) is an economically important carnivorous freshwater fish in China. In this study, we compared the properties of skin collagen from southern catfish fed with raw food (RF) and cooked food (CF). The skin collagen yield in the RF group (8.66 ± 0.11%) was significantly higher than that of the CF group (8.00 ± 0.27%). SDS-PAGE, circular dichroism spectroscopy, and FTIR analyses revealed that the collagen extracted from southern catfish skin in both groups was type I collagen, with a unique triple helix structure and high purity. The thermal denaturation temperature of collagen in the RF group (35.20 ± 0.11 ◦ C) was significantly higher than that of the CF group (34.51 ± 0.25 ◦ C). The DPPH free radical scavenging rates were 68.30 ± 2.41% in the RF collagen and 61.78 ± 3.91% in the CF collagen, which was higher than that found in most fish collagen. Both the RF and CF groups had high ability to form fibrils in vitro. Under the same conditions, the CF group exhibited faster fibril formation and a thicker fibril diameter ( p < 0.05). In addition, the RF group exhibited significantly higher expression of col1a1 compared to the CF group. These results indicated that feeding southern catfish raw food contributed to collagen production, and the collagen from these fish may have potential in biomaterial applications.
- containment hits: `anchor_8aa33654155`, `anchor_b73a9b0ba0d`

### `61.78 ± 3.91%`  (MULTI-GOLD)
- path: `['cf_dpph_rate']`
- note: REVIEW multi-gold: results p10 + abstract + DPPH paragraph
- gold `anchor_eb71e1b5f9a` (p10): 2.41%) than that of the CF group (61.78 ± 3.91%), but the difference between the two was
- gold `anchor_8aa33654155` (p1): Abstract: The southern catfish ( Silurus meridionalis ) is an economically important carnivorous freshwater fish in China. In this study, we compared the properties of skin collagen from southern catfish fed with raw food (RF) and cooked food (CF). The skin collagen yield in the RF group (8.66 ± 0.11%) was significantly higher than that of the CF group (8.00 ± 0.27%). SDS-PAGE, circular dichroism spectroscopy, and FTIR analyses revealed that the collagen extracted from southern catfish skin in both groups was type I collagen, with a unique triple helix structure and high purity. The thermal denaturation temperature of collagen in the RF group (35.20 ± 0.11 ◦ C) was significantly higher than that of the CF group (34.51 ± 0.25 ◦ C). The DPPH free radical scavenging rates were 68.30 ± 2.41% in the RF collagen and 61.78 ± 3.91% in the CF collagen, which was higher than that found in most fish collagen. Both the RF and CF groups had high ability to form fibrils in vitro. Under the same conditions, the CF group exhibited faster fibril formation and a thicker fibril diameter ( p < 0.05). In addition, the RF group exhibited significantly higher expression of col1a1 compared to the CF group. These results indicated that feeding southern catfish raw food contributed to collagen production, and the collagen from these fish may have potential in biomaterial applications.
- gold `anchor_29223a9d63a` (p9): Superior antioxidant properties are one of the main reasons why collagen is widely used in cosmetics, functional food ingredients, and additives [38]. The DPPH free radical scavenging rate of southern catfish skin collagen was higher in the RF group (68.30 ± 2.41%) than that of the CF group (61.78 ± 3.91%), but the difference between the two was not statistically significant (Figure 6). The antioxidant activity of collagen from the skin of southern catfish was higher than that of crimson snapper collagen (39.57 ± 0.99%), silver used in cosmetics, functional food ingredients, and additives [38]. The DPPH free radical scavenging rate of southern catfish skin collagen was higher in the RF group (68.30 ±
- containment hits: `anchor_8aa33654155`, `anchor_29223a9d63a`, `anchor_eb71e1b5f9a`

### `SPSS Base 25`  (single)
- path: `['statistics_software']`
- note: unique p5
- gold `anchor_58009cbd2db` (p5): Data are presented as the mean ± standard error (SE). Statistical analyses were performed using SPSS Base 25 statistical software (IBM, Armonk, NY, USA). After testing fornormal distribution and homogeneity of variance of the trial data, comparison among data within groups was conducted using one-way analysis of variance followed by Duncan's tests. p < 0.05 was considered to be statistically significant. In all graphs, SC means collagen, RF is collagen in the raw food group, and CF is collagen in the cooked food group.
- containment hits: `anchor_58009cbd2db`

### `GACGCTGTATGTGAAACGGC`  (MULTI-GOLD)
- path: `['primers', 0, 'sequence']`
- note: REVIEW multi-gold: col1a1-R row label anchor (table context) + sequence anchor
- gold `anchor_8d86be60f2f` (p5): col1a1-R
- gold `anchor_c850e50e68a` (p5): GACGCTGTATGTGAAACGGC
- containment hits: `anchor_c850e50e68a`

### `TATCTCCCCTTGGTCCCGAT`  (MULTI-GOLD)
- path: `['primers', 1, 'sequence']`
- note: REVIEW multi-gold: col1a2-R row label anchor (table context) + sequence anchor
- gold `anchor_4faa09e9a48` (p5): col1a2-R
- gold `anchor_223d719df99` (p5): TATCTCCCCTTGGTCCCGAT
- containment hits: `anchor_223d719df99`

### `Nicolet IS50`  (single)
- path: `['ftir_instrument']`
- note: unique p4
- gold `anchor_32cca9ee8ba` (p4): ATR-FTIR spectroscopy analysis of portions of the lyophilized collagen samples was conducted using a Fourier Transform Infrared Spectrometer (Nicolet IS50; Thermo Fisher Scientific). The scanning range was 600 to 4000 cm -1 with a resolution of 4 cm -1 , and the number of scans was 16 for both background and sample after atmospheric background deduction.
- containment hits: `anchor_32cca9ee8ba`

### `12,000 × g`  (single)
- path: `['centrifuge_speed']`
- note: unique p4, needs grouping-separator + symbol normalization
- gold `anchor_161b1292bbd` (p4): Twenty-four hours after collagen fibrils were formed, each mixture was centrifuged at 12,000 × g for 20 min using a micro cryo-centrifuge (model D3024R; Scilogex, Rocky Hill, CT, USA), and the precipitate was collected. At room temperature, 1 mL of electron microscope fixative containing 2.5% glutaraldehyde (No. G1102; Wuhan Xavier Biotechnology Co., Ltd., Wuhan, China) was added to the centrifuge tube, and the sample was fixed for 4 h. We washed each precipitate with PBS buffer and then sequentially treated it with ethanol solutions with volume fractions of 30%, 50%, 70%, and 100%. After gradient dehydration, each collagen fibril precipitate was treated with 1 mL tert-butanol, and the treatment was repeated twice. After removing the tert-butanol solution, the centrifuge tubes were placed in a freezer overnight at -80 ◦ C, and then they were dried in a vacuum-drying freezer.
- containment hits: `anchor_161b1292bbd`

### `zhangxi@mail.hzau.edu.com`  (ABSTAIN)
- path: `['corresponding_email']`
- note: ADVERSARIAL near-variant email (.com for .cn); verified absent
- containment hits (must be empty): none

### `8.66 ± 0.12%`  (ABSTAIN)
- path: `['rf_wet_extraction_rate']`
- note: ADVERSARIAL numeric near-variant; verified absent
- containment hits (must be empty): none

### `col1a3-F`  (ABSTAIN)
- path: `['primers', 2, 'name']`
- note: ADVERSARIAL: only col1a1/col1a2 primers exist; verified absent
- containment hits (must be empty): none

### `Kyoto University`  (ABSTAIN)
- path: `['affiliations', 2]`
- note: plain absent affiliation
- containment hits (must be empty): none

### `15 September 2024`  (ABSTAIN)
- path: `['published_date']`
- note: ADVERSARIAL near-variant of 13 September 2024; verified absent
- containment hits (must be empty): none


## ellekilde — 15 claims

### `Grav 8`  (MULTI-GOLD)
- path: `['records', 0, 'grave_label']`
- note: REVIEW multi-gold: grave heading + 'Fundliste grav 8' both evidence the label
- gold `anchor_540e94d0e16` (p1): Grav 8
- gold `anchor_39473e76ce2` (p1): Fundliste grav 8
- containment hits: `anchor_540e94d0e16`, `anchor_39473e76ce2`

### `over 45 år`  (single)
- path: `['records', 0, 'estimated_age']`
- note: unique containment, grave 8 anthropological assessment
- gold `anchor_3b23e3358bf` (p1): Antropologisk kunne skeletresterne bestemmes til at stamme fra en mand (?) på over 45 år. Gravudstyr: Der fandtes ved det ene lårben, halvt under dette, et stykke jern, der ikke umiddelbart kunne bestemmes nærmere. Efter konservering viste det sig at være et jernspænde.
- containment hits: `anchor_3b23e3358bf`

### `jernspænde`  (MULTI-GOLD)
- path: `['records', 0, 'finds', 0, 'description']`
- note: REVIEW multi-gold: find-list cell + prose mention
- gold `anchor_13264f1691a` (p1): jernspænde
- gold `anchor_3b23e3358bf` (p1): Antropologisk kunne skeletresterne bestemmes til at stamme fra en mand (?) på over 45 år. Gravudstyr: Der fandtes ved det ene lårben, halvt under dette, et stykke jern, der ikke umiddelbart kunne bestemmes nærmere. Efter konservering viste det sig at være et jernspænde.
- containment hits: `anchor_3b23e3358bf`, `anchor_13264f1691a`

### `25-35 år`  (single)
- path: `['records', 1, 'estimated_age']`
- note: unique, grave 13
- gold `anchor_faa3abc3e1c` (p2): Antropologisk kunne skeletresterne bestemmes til at stamme fra et individ af uvist køn på 25-35 år. Gravudstyr: Der fandtes intet gravudstyr
- containment hits: `anchor_faa3abc3e1c`

### `Yngre romersk jernalder per. C3`  (single)
- path: `['records', 2, 'dating']`
- note: REVIEW: substring also in grave 26's dating anchor_504ddb2; gold = grave 24's dating line
- gold `anchor_64a5a183460` (p3): Datering: Yngre romersk jernalder per. C3.
- containment hits: `anchor_64a5a183460`, `anchor_504ddb27457`

### `Perle af mat rødligt glas`  (single)
- path: `['records', 2, 'finds', 6, 'description']`
- note: unique table cell, find 24-7
- gold `anchor_0dacceee60e` (p3): Perle af mat rødligt glas
- containment hits: `anchor_0dacceee60e`

### `Lå mellem de to underarmsknogler (24-18)`  (single)
- path: `['records', 2, 'finds', 10, 'remarks']`
- note: unique table cell, find 24-16
- gold `anchor_d6a0d525a81` (p3): Lå mellem de to underarmsknogler (24-18)
- containment hits: `anchor_d6a0d525a81`

### `16-18 år`  (single)
- path: `['records', 3, 'estimated_age']`
- note: unique, grave 26
- gold `anchor_0f6b71abf27` (p4): Antropologisk kunne skeletresterne bestemmes til at stamme fra et individ af uvist køn på 16-18 år. Gravudstyr: Gravudstyret bestod af et større lerkar med hank af fint magret sortbrændt keramik beliggende i sydenden. I nordenden lå keramikfragmenter og 5 perler. De to (en blå glasperle og en ravperle) lå helt ude ved gravens vestlige kant. De tre øvrige perler (en hvid glasperle og to ravperler) lå i den østlige side af nordenden.
- containment hits: `anchor_0f6b71abf27`

### `15`  (single)
- path: `['records', 3, 'tooth_count']`
- note: hard: bare number, lexically ambiguous everywhere; source says 'i alt 15 tænder'
- gold `anchor_61cb7f12f88` (p4): Af skelettet var primært bevaret tænder og tandemalje fra gravens nordlige del, i alt 15 tænder. Skeletdelene er nummereret som følger:
- containment hits: `anchor_479591a0055`, `anchor_75304c9b7fe`, `anchor_f6c4c4a53f1`, `anchor_61cb7f12f88`, `anchor_f9c02eb1de9`

### `2.8 x 1.3 meter`  (single)
- path: `['records', 3, 'grave_dimensions']`
- note: normalization test: source has decimal commas '2,8 x 1,3 meter'
- gold `anchor_72d2d735426` (p4): Beskrivelse: Graven målte ved undergrundsniveau 2,8 x 1,3 meter, og i de to nederste niveauer 2,5 x 0,7 meter. Dybden fra undergrundsniveau var ca. 50 cm. Graven var orientering N-S. Hovedet må have ligget i nord, da der her fandtes tandemalje. I sydenden har der muligvis været gravet en lille afsats, hvorpå lerkarret stod (x24-10). Under lerkarret var der undergrund, mens denne først blev nået ca. 10 cm længere nede i resten af graven.
- containment hits: `anchor_72d2d735426`

### `1450 BP`  (ABSTAIN)
- path: `['records', 0, 'radiocarbon_date']`
- note: not in document — must abstain
- containment hits (must be empty): none

### `Nationalmuseet i København`  (ABSTAIN)
- path: `['storage_location']`
- note: not in document — must abstain
- containment hits (must be empty): none

### `Yngre romersk jernalder per. C2`  (ABSTAIN)
- path: `['records', 2, 'dating']`
- note: ADVERSARIAL: near-variant of present per. C3 — must abstain
- containment hits (must be empty): none

### `17-18 år`  (ABSTAIN)
- path: `['records', 3, 'estimated_age']`
- note: ADVERSARIAL: near-variant of present 16-18 år — must abstain
- containment hits (must be empty): none

### `8-5`  (ABSTAIN)
- path: `['records', 0, 'finds', 1, 'find_number']`
- note: ADVERSARIAL: hallucinated find id; 8-1..8-4 exist — must abstain
- containment hits (must be empty): none


## free-ports-hamburg — 13 claims

### `Free ports, political economy, and early globalization: Evidence from 1750s Hamburg`  (MULTI-GOLD)
- path: `['title']`
- note: REVIEW multi-gold: title block + citation footer
- gold `anchor_715a690ae19` (p1): Free ports, political economy, and early globalization: Evidence from 1750s Hamburg
- gold `anchor_1476e1268dd` (p24): Cite this article: Sahle, E., ' Free ports, political economy, and early globalization: Evidence from 1750s Hamburg ' , Journal of Global History (2026). doi:10.1017/S1740022825100314
- containment hits: `anchor_715a690ae19`, `anchor_1476e1268dd`

### `Esther Sahle`  (MULTI-GOLD)
- path: `['author']`
- note: REVIEW multi-gold: byline + running headers (decide if headers count as evidence)
- gold `anchor_88f4fa65a5b` (p1): Esther Sahle 1, 2
- gold `anchor_0818d48dc5c` (p2): 2 Esther Sahle
- gold `anchor_5f4b01d8e7c` (p4): 4 Esther Sahle
- gold `anchor_44e6909168b` (p24): Esther Sahle holds a PhD in Economic history from the London School of Economics and at present an assistant professor of economic history at the University of Copenhagen.
- containment hits: `anchor_88f4fa65a5b`, `anchor_0818d48dc5c`, `anchor_5f4b01d8e7c`, `anchor_44e6909168b`

### `University of Copenhagen, Saxo Institute`  (single)
- path: `['author_affiliations', 1]`
- note: unique
- gold `anchor_f526f6d7993` (p1): 1 Free University of Berlin, Berlin, Germany and 2 University of Copenhagen, Saxo Institute, Berlin, Germany Email: e.sahle@fu-berlin.de
- containment hits: `anchor_f526f6d7993`

### `Cambridge University Press`  (single)
- path: `['publisher']`
- note: hard: 9 lexical hits (many footnote citations); gold = the © / open-access statement
- gold `anchor_bf89e84c6f5` (p1): © The Author(s), 2026. Published by Cambridge University Press. This is an Open Access article, distributed under the terms of the Creative Commons Attribution licence (https://creativecommons.org/licenses/by/4.0/), which permits unrestricted re-use, distribution and reproduction, provided the original article is properly cited.
- containment hits: `anchor_6982be468fc`, `anchor_bf89e84c6f5`, `anchor_5ab1622aae4`, `anchor_d9031215d13`, `anchor_2e482f1f38f`, `anchor_6f1997430ce`, `anchor_fafa63c9b66`, `anchor_48a484b80e5`, `anchor_474e09f4298`

### `1591`  (single)
- path: `['records', 0, 'free_port_year']`
- note: REVIEW: 2 hits; gold = Livorno year cell in table 1; claim is for Livorno row
- gold `anchor_4d4f009f7ea` (p7): 1591
- containment hits: `anchor_4d4f009f7ea`, `anchor_bd257a4cdd6`

### `Livorno`  (single)
- path: `['records', 0, 'port']`
- note: hard: 11 lexical hits across prose/footnotes; gold = table 1 port cell
- gold `anchor_b771fc1a940` (p7): Livorno
- containment hits: `anchor_d55b6c1b8ba`, `anchor_8b0bd48adda`, `anchor_fee70e68426`, `anchor_13b73f19f3b`, `anchor_c829a9e20d7`, `anchor_1631b6f6eed`, `anchor_7814dcf44bc`, `anchor_3814c039331`, `anchor_b771fc1a940`, `anchor_26e7bd9a373`, `anchor_fc0726eda10`

### `1664`  (single)
- path: `['records', 8, 'free_port_year']`
- note: unique, Altona year cell
- gold `anchor_e6b6e28c620` (p7): 1664
- containment hits: `anchor_e6b6e28c620`

### `1706`  (single)
- path: `['records', 12, 'free_port_year']`
- note: unique, Gibraltar year cell
- gold `anchor_1215213c04a` (p7): 1706
- containment hits: `anchor_1215213c04a`

### `1766`  (single)
- path: `['records', 24, 'free_port_year']`
- note: was KNOWN-HARD (identical year cells) — row context should now disambiguate
- gold `anchor_1ec2abd17b7` (p7): 1766
- containment hits: `anchor_13b73f19f3b`, `anchor_3c1ad3ac3d8`, `anchor_1ec2abd17b7`, `anchor_73bd442e84f`, `anchor_a509e89f566`, `anchor_ff608eaf4a3`, `anchor_0bfed4de2c0`, `anchor_3f2484f4ec0`, `anchor_e415399105d`, `anchor_e074254080c`, `anchor_13361442296`, `anchor_10fd553e04d`

### `University of Oxford`  (ABSTAIN)
- path: `['author_affiliations', 0]`
- note: not in document — must abstain
- containment hits (must be empty): none

### `Esther Sahler`  (ABSTAIN)
- path: `['author']`
- note: ADVERSARIAL: misspelled author name — must abstain
- containment hits (must be empty): none

### `1592`  (ABSTAIN)
- path: `['records', 0, 'free_port_year']`
- note: ADVERSARIAL: off-by-one of present 1591 — must abstain
- containment hits (must be empty): none

### `159`  (ABSTAIN)
- path: `['records', 0, 'free_port_year']`
- note: ADVERSARIAL: substring trap: appears only inside longer numbers (6 anchors) — must abstain
- containment hits (must be empty): none


## herredsvejen — 23 claims

### `SBM1694`  (single)
- path: `['journal_number']`
- note: title page; NB SBM1194 (forundersogelse) is a different number
- gold `anchor_fb53d73b0be` (p1): SBM1694 Herredsvejen etape I
- containment hits: `anchor_fb53d73b0be`

### `Merethe Schifter Bagge`  (MULTI-GOLD)
- path: `['excavation_leader']`
- note: REVIEW multi-gold: front page + signature p24 + staff list p7
- gold `anchor_30e2ff5d0f8` (p1): Undersøgelsen er udført i efteråret 2019 af Museum Skanderborg. Daglig leder Merethe Schifter Bagge.
- gold `anchor_941fb6c38aa` (p24): Cand. Mag. Merethe Schifter Bagge
- gold `anchor_d33917c2342` (p7): Udgravningen af de tre felter blev udført i perioden 23. september til 20. november 2019, dog med en længere pause mellem d. 14. oktober og d. 18. november, hvor der afventes godkendelse til at grave indenfor 100m zonen til gravhøjen sb. 160205-11. Udgravningsarbejdet blev udført af Cand. Mag. Anders Hagen Mørk, Cand. Mag. Birgitte Bang Madsen og Cand. Mag. Merethe Schifter Bagge (daglig leder). Maskinen, som var en 25 tons gravemaskine på bånd, blev leveret af KM Maskiner og ført af
- containment hits: `anchor_30e2ff5d0f8`, `anchor_d33917c2342`, `anchor_941fb6c38aa`

### `23-09-2019`  (MULTI-GOLD)
- path: `['campaign_start']`
- note: REVIEW multi-gold: campaign line (numeric), sagsgang entry, period sentence
- gold `anchor_122c7838e35` (p1): Kampagne: 23-09-2019 SLKS nr. 19/06370
- gold `anchor_036fde44f39` (p5): 23. september 2019: Udgravningen starter op.
- gold `anchor_d33917c2342` (p7): Udgravningen af de tre felter blev udført i perioden 23. september til 20. november 2019, dog med en længere pause mellem d. 14. oktober og d. 18. november, hvor der afventes godkendelse til at grave indenfor 100m zonen til gravhøjen sb. 160205-11. Udgravningsarbejdet blev udført af Cand. Mag. Anders Hagen Mørk, Cand. Mag. Birgitte Bang Madsen og Cand. Mag. Merethe Schifter Bagge (daglig leder). Maskinen, som var en 25 tons gravemaskine på bånd, blev leveret af KM Maskiner og ført af
- containment hits: `anchor_122c7838e35`

### `20. november 2019`  (MULTI-GOLD)
- path: `['campaign_end']`
- note: REVIEW multi-gold: sagsgang entry + period sentence
- gold `anchor_c20ee246bb9` (p5): 20. november 2019 afsluttes udgravningen.
- gold `anchor_d33917c2342` (p7): Udgravningen af de tre felter blev udført i perioden 23. september til 20. november 2019, dog med en længere pause mellem d. 14. oktober og d. 18. november, hvor der afventes godkendelse til at grave indenfor 100m zonen til gravhøjen sb. 160205-11. Udgravningsarbejdet blev udført af Cand. Mag. Anders Hagen Mørk, Cand. Mag. Birgitte Bang Madsen og Cand. Mag. Merethe Schifter Bagge (daglig leder). Maskinen, som var en 25 tons gravemaskine på bånd, blev leveret af KM Maskiner og ført af
- containment hits: `anchor_c20ee246bb9`, `anchor_d33917c2342`

### `19/06370`  (single)
- path: `['slks_number']`
- note: unique, campaign line p1
- gold `anchor_122c7838e35` (p1): Kampagne: 23-09-2019 SLKS nr. 19/06370
- containment hits: `anchor_122c7838e35`

### `576`  (single)
- path: `['total_feature_count']`
- note: unique, results overview p8
- gold `anchor_7227d563157` (p8): Der blev registreret i alt 576 anlæg på udgravningen. Heraf 362 stolpehuller, 89 fyldskifter, 58 naturfænomener, 25 gruber, 18 der udgår, 9 sten/stenspor, 7 agerrener, 3 grave, 2 recente forstyrrelser samt kanten af en gravhøj. AMS-dateringer, hustypologi og genstande peger på, at der er spor efter flere oldtidsperioder; yngre stenalder, ældre bronzealder, yngre jernalder og historisk tid. I det følgende vil resultaterne blive gennemgået med udgangspunkt i den overpløjede
- containment hits: `anchor_7227d563157`

### `362`  (single)
- path: `['posthole_count']`
- note: unique, results overview p8
- gold `anchor_7227d563157` (p8): Der blev registreret i alt 576 anlæg på udgravningen. Heraf 362 stolpehuller, 89 fyldskifter, 58 naturfænomener, 25 gruber, 18 der udgår, 9 sten/stenspor, 7 agerrener, 3 grave, 2 recente forstyrrelser samt kanten af en gravhøj. AMS-dateringer, hustypologi og genstande peger på, at der er spor efter flere oldtidsperioder; yngre stenalder, ældre bronzealder, yngre jernalder og historisk tid. I det følgende vil resultaterne blive gennemgået med udgangspunkt i den overpløjede
- containment hits: `anchor_7227d563157`

### `Poul Kragh`  (single)
- path: `['machine_operator']`
- note: unique p7
- gold `anchor_c0395884a7d` (p7): maskinfører Poul Kragh.
- containment hits: `anchor_c0395884a7d`

### `Skanderborg Kommune, Teknik og Miljø`  (single)
- path: `['developer']`
- note: unique, administrative data p5
- gold `anchor_97f36f8b78f` (p5): Bygherre: Skanderborg Kommune, Teknik og Miljø, Skanderborg Fælled 1, 8660 Skanderborg. Kontaktperson: Lars Lykke Jensen Ansvarlig for undersøgelsen: Museum Skanderborg, Jernbanevej 9, 8660 Skanderborg. Dokumentationsmateriale bestående af fund, fotos, tegninger og beretning opbevares på
- containment hits: `anchor_97f36f8b78f`

### `Lars Lykke Jensen`  (single)
- path: `['developer_contact']`
- note: unique p5
- gold `anchor_97f36f8b78f` (p5): Bygherre: Skanderborg Kommune, Teknik og Miljø, Skanderborg Fælled 1, 8660 Skanderborg. Kontaktperson: Lars Lykke Jensen Ansvarlig for undersøgelsen: Museum Skanderborg, Jernbanevej 9, 8660 Skanderborg. Dokumentationsmateriale bestående af fund, fotos, tegninger og beretning opbevares på
- containment hits: `anchor_97f36f8b78f`

### `ca. 23 m`  (single)
- path: `['mound_diameter']`
- note: unique p8
- gold `anchor_e1d16a1197c` (p8): ude i marken blev også målt ind, og gravhøjen blev oprettet i FF. Oprindeligt har højen haft en diameter på ca. 23 m. Pløjejorden over højen blev afsøgt med metaldetektor uden resultat.
- containment hits: `anchor_e1d16a1197c`

### `13,5 m`  (single)
- path: `['records', 0, 'house_length']`
- note: K7 length, unique p18
- gold `anchor_68f25e6d447` (p18): K7, som er den bygning der har det bedst afklaret forløb af vægstolper, er 13,5 m lang. K11 er helt klart den længste bygning med mindst seks sæt tagbærende stolper. K11 er mindst 18 m lang. De øvrige huse har mellem to (K1, K7 og K8) og tre (K6 og K10) sæt tagbærende. I to sæts husene varierede spændet mellem de to sæt mellem 5,1, 5,3 og 6,7 m.
- containment hits: `anchor_68f25e6d447`

### `X233`  (MULTI-GOLD)
- path: `['records', 1, 'find_number']`
- note: REVIEW multi-gold: figure caption + find list + description
- gold `anchor_18313ce3b66` (p11): Figur 8: De to gravgaver fra brandpletten, A225. Til venstre ses karret, X24, som det lå efter let afrensning. Der ses stadig lidt knogle mellem skårene. Til højre ses de røde glasperle, X233. Begge gravgaver har spor efter stærk ildpåvirkning.
- gold `anchor_a4e5b2d0e6d` (p11): I brandpletten lå et stærkt sintret lille kar (X24+X120) og en sintret glasperle (X233).
- gold `anchor_5d3db8876b9` (p12): X233 er en lille rørformet, rød, mat glasperle, som tydeligt har været med på bålet, da den er helt boblet op i den ene side. Perlen måler 6 x 4 mm.
- containment hits: `anchor_18313ce3b66`, `anchor_a4e5b2d0e6d`, `anchor_5d3db8876b9`

### `6 x 4 mm`  (single)
- path: `['records', 1, 'bead_size']`
- note: unique p12
- gold `anchor_5d3db8876b9` (p12): X233 er en lille rørformet, rød, mat glasperle, som tydeligt har været med på bålet, da den er helt boblet op i den ene side. Perlen måler 6 x 4 mm.
- containment hits: `anchor_5d3db8876b9`

### `AAR 33273`  (single)
- path: `['records', 2, 'ams_lab_number']`
- note: unique p12
- gold `anchor_63fdd9a6f47` (p12): Der er foretaget to AMSdateringer på materiale (havre og korn) fra graven: AAR 33273 og AAR 33284. Begge prøver havde desværre en ugyldig datering. Ud fra karret og glasperlen dateres graven forsigtigt til yngre romersk jernalder/ældre germansk jernalder.
- containment hits: `anchor_63fdd9a6f47`

### `41 fragmenter`  (single)
- path: `['urn_fragment_count']`
- note: unique p9; bare '41' also appears as cm depth elsewhere
- gold `anchor_8b631316cef` (p9): Selve karbunden lå i 41 fragmenter. Karret var tyndvægget, mørkt brunt, fint magret og meget afglattet.
- containment hits: `anchor_8b631316cef`

### `5.853 m2`  (single)
- path: `['preinvestigation_area']`
- note: unique p4, grouping separator
- gold `anchor_5a1c177ea58` (p4): Den systematiske udgravning er baseret på en forundersøgelse (SBM1194 Herredsvejen FU) som er foretaget forud for ny-anlæggelse af Herredsvejen. I forundersøgelsen blev der indstillet 5.853 m2 til systematisk, men det endte med, at der kun blev udgravet knap 4400m2, pga. svær traktose og ledninger langs vejen.
- containment hits: `anchor_5a1c177ea58`

### `1300 m2`  (single)
- path: `['zone_permit_area']`
- note: written '1300m2' without space in the document — lexical should miss
- gold `anchor_9f47ea13623` (p5): 7. oktober 2019 blev der ansøgt om tilladelse til at udgrave 1300m2 i 100m zonen af gravhøjen sb.26.
- containment hits: none

### `SBM1695`  (ABSTAIN)
- path: `['journal_number']`
- note: ADVERSARIAL near-variant of SBM1694/SBM1194; verified absent
- containment hits (must be empty): none

### `AAR 33274`  (ABSTAIN)
- path: `['records', 2, 'ams_lab_number']`
- note: ADVERSARIAL near-variant of AAR 33273/33284; verified absent
- containment hits (must be empty): none

### `Merete Schifter Bagge`  (ABSTAIN)
- path: `['excavation_leader']`
- note: ADVERSARIAL misspelling (missing h); verified absent
- containment hits (must be empty): none

### `K14`  (ABSTAIN)
- path: `['records', 0, 'construction_id']`
- note: ADVERSARIAL: document uses K-numbers K1-K13 only; K14 verified absent
- containment hits (must be empty): none

### `Nationalmuseet`  (ABSTAIN)
- path: `['conservation_institution']`
- note: plain absent value
- containment hits (must be empty): none


## hojbakkegaard — 17 claims

### `TAK 1177`  (MULTI-GOLD)
- path: `['journal_number']`
- note: REVIEW multi-gold: data section + report titles + prose
- gold `anchor_9a60b8b8638` (p20): J. Nr.: TAK 1177
- gold `anchor_d850df38f5a` (p1): Rapport om de arkæologiske undersøgelser ved Højbakkegård, TAK 1177
- gold `anchor_704826c0edd` (p20): Rapport for den arkæologiske udgravning ved Højbakkegård, TAK 1177
- gold `anchor_6999d3d5465` (p3): Nærværende rapport dækker den arkæologiske udgravning ved Den Kongelige veterinær- og Landbohøjskole i Taastrup, kaldet Højbakkegård, TAK 1177. Udgravningen fandt sted i perioden 1. til 28. september 2005 og i perioden 7. til 19. december 2005.
- containment hits: `anchor_d850df38f5a`, `anchor_6999d3d5465`, `anchor_704826c0edd`, `anchor_9a60b8b8638`

### `020214-65, -66`  (single)
- path: `['site_number']`
- note: unique; punctuation-heavy id
- gold `anchor_83f13172419` (p20): Stednummer: 020214-65, -66
- containment hits: `anchor_83f13172419`

### `Tom Giersing`  (single)
- path: `['daily_leader']`
- note: unique
- gold `anchor_51b6ddcfa56` (p20): Daglig leder: Tom Giersing
- containment hits: `anchor_51b6ddcfa56`

### `Mette Brosolat Ohlsen`  (MULTI-GOLD)
- path: `['report_author']`
- note: REVIEW multi-gold: credits line + title byline
- gold `anchor_a76cdef2866` (p20): Beretning og bygherrerapport: Cand. mag Mette Brosolat Ohlsen
- gold `anchor_133c36120cd` (p1): Af Mette Brosolat Ohlsen Kroppedal, Museum for Astronomi · Nyere tid · Arkæologi Kroppedals Allé 3, 2630 Taastrup
- containment hits: `anchor_133c36120cd`, `anchor_a76cdef2866`

### `ca. 210-250 e.Kr`  (single)
- path: `['records', 0, 'dating']`
- note: unique, grave 87 dating
- gold `anchor_1df768b7d8f` (p10): Datering yngre romersk jernalder C1b (ca. 210-250 e.Kr).
- containment hits: `anchor_1df768b7d8f`

### `ca. 400 e.Kr.`  (single)
- path: `['records', 1, 'dating']`
- note: REVIEW: 2 hits (grave 6 prose anchor_8026bbc, grave 9 dating line); claim is for grave 9 -> gold anchor_4cb663f
- gold `anchor_4cb663f7eac` (p11): Datering: Tidlig ældre germansk jernalder D (ca. 400 e.Kr.).
- containment hits: `anchor_8026bbc53f5`, `anchor_4cb663f7eac`

### `32`  (single)
- path: `['records', 2, 'tooth_count']`
- note: hard: bare number; source '32 tænder er bevaret', grave 86
- gold `anchor_546040a3e1e` (p12): 32 tænder er bevaret samt en spytsten (antropologisk bestemmelse ved lic.scient. Pia Bennike) lå i munden. Tændernes slid tyder på et voksent individ på ca. 35-45 år. Ud fra mål på den afdøde i felten var den gravlagte ca. 1,7 meter høj. Der var ingen gravgaver i graven.
- containment hits: `anchor_546040a3e1e`

### `2.20 meter`  (single)
- path: `['records', 3, 'grave_length']`
- note: normalization test: source has '2,20 meter', grave 6
- gold `anchor_e183d0f5fc4` (p9): Jordfæstegrav, der i udgravningsfladen viste sig som en 2,20 meter langt og 1,0 meter bredt nord - sydvendt mørkebrunt fyldskifte. Der var kistespor i ca. 15 cm's dybde fra udgravningsfladen. Kisten målte 1,75 x 0,75 meter i en rektangulær form. Graven lå ikke sammen med de øvrige jernaldergrave, men lå på den sydøstlige side af gravhøjen. der var kun få knoglefragmenter tilbage. Dog var der et fedtet aftryk i bunden af kisten, der
- containment hits: `anchor_e183d0f5fc4`

### `Lone Brorson`  (single)
- path: `['conservator']`
- note: unique
- gold `anchor_1b0366f3c39` (p20): Konserveringsarbejde: Konserveringstekniker Lone Brorson
- containment hits: `anchor_1b0366f3c39`

### `Jan Poulsen`  (single)
- path: `['surveyor']`
- note: unique
- gold `anchor_04f72452ee4` (p20): Opmåling med GPS samt bearbejdning af planer blev foretaget af museumstekniker Jan Poulsen
- containment hits: `anchor_04f72452ee4`

### `2004-08-13`  (single)
- path: `['budget_approval_date']`
- note: hard: ISO date vs '13. august 2004' (month name) — lexical cannot match, neural tier must
- gold `anchor_143c9746911` (p4): Kulturarvsstyrelsen godkendte budget for en egentlig udgravning den 13. august 2004. Bygherre meddelte den 26. oktober 2004, at dato for byggeriets start ikke var fastlagt, og at udgravningerne derfor ikke ønskedes igangsat. Efter aftale med bygherre tildækkedes arealet med vintermåtter. Februar 2005 anmodede bygherre om et nyt budget.
- containment hits: none

### `55.6702 N`  (ABSTAIN)
- path: `['gps_latitude']`
- note: not in document — must abstain
- containment hits (must be empty): none

### `3950 BP`  (ABSTAIN)
- path: `['records', 0, 'radiocarbon_date']`
- note: not in document — must abstain
- containment hits (must be empty): none

### `TAK 1178`  (ABSTAIN)
- path: `['journal_number']`
- note: ADVERSARIAL: near-variant of present TAK 1177 — must abstain
- containment hits (must be empty): none

### `020214-67`  (ABSTAIN)
- path: `['site_number']`
- note: ADVERSARIAL: near-variant of present 020214-65, -66 — must abstain
- containment hits (must be empty): none

### `33`  (ABSTAIN)
- path: `['records', 2, 'tooth_count']`
- note: ADVERSARIAL: off-by-one of present 32 — must abstain
- containment hits (must be empty): none

### `17. august 2004`  (ABSTAIN)
- path: `['budget_approval_date']`
- note: ADVERSARIAL: near-variant of present 13. august 2004 — must abstain
- containment hits (must be empty): none


## hvissinge — 22 claims

### `TAK 1728`  (MULTI-GOLD)
- path: `['journal_number']`
- note: REVIEW multi-gold: title page + packing-label example
- gold `anchor_a4fb0e662bb` (p1): TAK 1728 Bygherrerapport om gravplads fra jernalderen
- gold `anchor_5ae966b93db` (p5): Så indsamlede vi knogler, præparater og andre fund. Vi optog dyre- og menneskeknogler i anatomisk orden og pakkede den separat i syrefrit silkepapir med manillamærker med informationer om kontekst, anatomisk og geografisk placering (fx "TAK 1728 Hvissinge Øst, grav 6, venstre femur vest..."). Vi gravede alle præparater fri på alle sider, stabiliserede med plastikfilm (VitaWrap) og gaze, og løftede dem op på faste plader. I praksis viste nogle præparater sig mere stabile end andre, og i grav 6 havde vi problemer, da gravens hovedende overlejrede en stor sten, vi ikke kunne tage med op.
- containment hits: `anchor_a4fb0e662bb`, `anchor_5ae966b93db`

### `Bo Jensen`  (MULTI-GOLD)
- path: `['report_author']`
- note: REVIEW multi-gold: byline + text + figure caption
- gold `anchor_e6a27f42262` (p1): Af Bo Jensen, arkæolog, Kroppedal museum
- gold `anchor_b658d978bc5` (p2): Rent formelt har Kroppedal museum ansvar for at arkivere alle sagsakter. Den daglige udgravningsleder var undertegnede, Bo Jensen, og museets ansvarlige arkæolog var Linda Boye. Myndighedsansvaret ligger hos Slots- og kulturstyrelsen, hvor sagen er registreret under journalnummer 16/02957.
- gold `anchor_ed35116b6db` (p4): Metode: balkprofi lerne tegnes i 1:10. Bo Jensen i grav 2.
- containment hits: `anchor_e6a27f42262`, `anchor_b658d978bc5`, `anchor_ed35116b6db`

### `Linda Boye`  (MULTI-GOLD)
- path: `['responsible_archaeologist']`
- note: REVIEW multi-gold
- gold `anchor_b658d978bc5` (p2): Rent formelt har Kroppedal museum ansvar for at arkivere alle sagsakter. Den daglige udgravningsleder var undertegnede, Bo Jensen, og museets ansvarlige arkæolog var Linda Boye. Myndighedsansvaret ligger hos Slots- og kulturstyrelsen, hvor sagen er registreret under journalnummer 16/02957.
- gold `anchor_340c98e9af1` (p6): Metode: de skrøbeligere genstande kan stabiliseres i felten med gaze og plas ࢼ kfi lm, og udgraves i laboratoriet. Linda Boye i grav 2.
- gold `anchor_1e2a97a0d55` (p18): De to bådgrave indeholdt knogler af dyr, der synes ofret i forbindelse med begravelserne. Ofringer af får er ganske typiske for ældre romersk jernalder, og Linda Boye har katalogiseret 31 eksempler fra Sjælland. Det er helt typisk, at fårene er delt i to, som i Hvissinge, og både det mønster, vi ser i grav 3, med fårets ov g s ved i gravens hovedende, har talrige paralleller. Der er altså tale om en veletableret og ganske konsekvent gravskik, delt af en relativt bred elite i jernalderens samfund på Sjælland. I yngre romersk jernalder viser nedlæggelser af animalsk materiale meget større variation, men da er dyrene ofte eksotiske, og ofte meget mere parterede. Fuglen i grav 3 har ingen kendte paralleller, men de spinkle fugleknogler bevares dårligt i jorden. I Hvissinge, og især i grav 3, ser vi helt ekseptionelt god bevaring af ben.
- containment hits: `anchor_b658d978bc5`, `anchor_340c98e9af1`, `anchor_1e2a97a0d55`

### `20-06-2016`  (single)
- path: `['trial_excavation_start']`
- note: unique, numeric date p2
- gold `anchor_b9626568d28` (p2): I perioden 20-06-2016 til 01-07-2016 prøvegravede Kroppedal Museum et område vest for Sortevej i Hvissinge. Prøvegravningen var bestilt af Glostrup Kommune, der ønsker at byggemodne området. Den forløb over to uger, og afslørede de første tre grave (grav 1, 2 og 3). Da grav 1 og lerkarret i grav 2 allerede var meget eksponerede, var det nødvendigt, at udgrave disse i prøvegravningen. Forundersøgelsen viste, at der var velbevarede jernaldergrave på området, og museet indstillede derfor gravpladsen til egentlig udgravning. Denne forløb over 4½2 uge, fra 13-07-2016 til 15-08-2016.
- containment hits: `anchor_b9626568d28`

### `27-07-2016`  (MULTI-GOLD)
- path: `['open_house_date']`
- note: REVIEW multi-gold: open-house sentence p4 + press paragraph p3
- gold `anchor_a155015fd9f` (p4): Den store interesse påvirkede uundgåeligt arbejdet. Onsdag den 27-07-2016 holdt vi åbent hus. Denne dag prioriterede vi at tømme bådgraven (grav 3) for alle synlige knogler og fund. På grund af de mange besøgende kunne vi først begynde denne arbejdsproces omkring 14:30, så vi var færdige omkring 22:00. På det tidspunkt var dagslyset også for dårligt til, at vi kunne forsvare at fortsætte arbejdet.
- gold `anchor_b27b10f35d8` (p3): Prøvegravningen omfatter arealer, der synlige fra de lokale veje og cykelstier, men den lokale interesse i prøvegravningen var minimal. I løbet af hele prøvegravningen talte jeg med to mennesker, der havde heste på rideskolen, og med Kurt Herskind, en at museets faste metaldetektorførere, der også arbejder for Glostrup Kommunes vej- og parkafdeling. Den egentlige udgravning lå noget isoleret fra trafikårerne, gemt bag ved levende hegn og en hestefold, så indtil gravningen blev omtalt i pressen, var opmærksomheden minimal. Den 27-07-2016 holdt vi åbent hus, og herefter var der besøgende næsten alle dage. Udgravningen faldt i "agurketiden", samtidigt med folketingets sommerferie, efter fodbold-VM
- containment hits: `anchor_b27b10f35d8`, `anchor_a155015fd9f`

### `267`  (single)
- path: `['visitor_count']`
- note: unique p3
- gold `anchor_39bb0aa22e1` (p3): Oversigt over 267 besøgende. E[ er åbent hus onsdag den 27-07 var der besøg næsten hver dag.
- containment hits: `anchor_39bb0aa22e1`

### `cirka 173 cm`  (single)
- path: `['records', 0, 'body_height']`
- note: grav 4, unique p11
- gold `anchor_cc1c4dac3dd` (p11): Knoglerne er i felten identificeret som sandsynligvis kvindelige. Målt fra kraniet over hofter og knæ til hælen har den døde været cirka 173 cm høj. Knoglebevarelsen er hæderlig, ikke så fin som i grav 1 og 3, men meget bedre end i grav 2. På højre lårben ses et rent brud, rimeligvis efter døden. Der er ingen tegn på heling.
- containment hits: `anchor_cc1c4dac3dd`

### `135 cm`  (single)
- path: `['records', 1, 'measured_height']`
- note: grav 5, unique p11
- gold `anchor_0a1cae114ce` (p11): Den døde målte 135 cm fra issen til den nederste bevarede knogle. Da vi mangler alle fodknogler, og hele den nederst del af underbenene (tibia og fibula), er denne højde meget lidt sigende. Reelt har den døde nok været mindst 160 cm høj, måske endda
- containment hits: `anchor_0a1cae114ce`

### `172 cm`  (single)
- path: `['records', 2, 'body_height']`
- note: grav 6, unique p12
- gold `anchor_c1c385a8c88` (p12): Den døde lå i løs hocker, på sin venstre side, med hovedet i nord og ansigtet mod øst. Knoglerne var meget velbevarede. Vi har i felten foreløbigt identificeret denne person som en kvinde. Målt fra issen over hofter og knæ til hælen var hun anslået 172 cm høj.
- containment hits: `anchor_c1c385a8c88`

### `58 cm`  (single)
- path: `['boat_width']`
- note: unique p10; '58 cm' also appears in the Slusegard/Egholm comparison (anchor_63679bcf2d6) which is NOT evidence for the Hvissinge boat
- gold `anchor_942ba80df00` (p10): lang, flad bund i midten, mere U-formet i snit halvvejs til stævnen, og V-formet i snit i stævnene, indtil 58 cm bred, med sider, der var 3 til 5 cm tykke. Rælingshøjden er mindst 38 cm, stævnenes højde ii, se e bse. Denne detalje kendes også fra bådene på Slusegård, på Bornholm. Som nævnt ovenfor, er båden sandsynligvis en stammebåd, lavet af ét sammenhængende stykke træ. Der er ingen spor af indre konstruktioner. På Slusegård rekonstruerer Ole CrumlinPetersen og Ole Klindt-Jensen bådene med tværgående spanter i bunden, vel en slags forstærkning af skroget. Dette træk er ikke dokumenteret i Hvissinge, men her var bunden meget dårligt bevaret. I lyset af moderne småbådes udformning er det oplagt at spekulere på, om der ikke har været tværstillede bord højere oppe, lige under rælingslinjens niveau, men igen er disse ikke observeret. Ba et ss ys h es e ens hovedende svarer til bådens forstavn. Jeg formoder, at en båd i denne størrelse havde sejlegenskaber som en moderne kano. Den erns e ar eed ee r t il rejser på store åer (som Store Vejleå og Rødovre Å), og måske til kystsejlads i stille vejr, men ikke velegnet til at krydse åbent hav eller transportere en stor last. De berømte fund fra Hjortspring og Nydam viser, at jernalderens mennesker også rådede over langt større, mere sødygtige fartøjer.
- containment hits: `anchor_942ba80df00`, `anchor_63679bcf2d6`

### `Kurt Herskind`  (single)
- path: `['metal_detectorist']`
- note: unique p3
- gold `anchor_b27b10f35d8` (p3): Prøvegravningen omfatter arealer, der synlige fra de lokale veje og cykelstier, men den lokale interesse i prøvegravningen var minimal. I løbet af hele prøvegravningen talte jeg med to mennesker, der havde heste på rideskolen, og med Kurt Herskind, en at museets faste metaldetektorførere, der også arbejder for Glostrup Kommunes vej- og parkafdeling. Den egentlige udgravning lå noget isoleret fra trafikårerne, gemt bag ved levende hegn og en hestefold, så indtil gravningen blev omtalt i pressen, var opmærksomheden minimal. Den 27-07-2016 holdt vi åbent hus, og herefter var der besøgende næsten alle dage. Udgravningen faldt i "agurketiden", samtidigt med folketingets sommerferie, efter fodbold-VM
- containment hits: `anchor_b27b10f35d8`

### `Hanus Jensen`  (single)
- path: `['boat_reconstruction_expert']`
- note: unique p15
- gold `anchor_5d9e995eec8` (p15): Vikingeskibsmuseet, ved Hanus Jensen, har eksperimenteret med at rekonstruere en af Slusegårdbådene, ved at lægge den udhuggede egetræsbåd i vand i en måned og derefter opvarme den mellem to bål indtil den kunne udspændes med tværstivere. Eksperimentet lykkedes ikke perfekt, og båden sprækkede. I et andet eksperiment, baseret på den svenske Björkebåd, i lind, blev stammen varmet direkte i et bål. Igen sprækkede båden under udspændingen. Til gengæld lykkedes det, at rekonstruere en båd fra Tuna i Badelunda, i gran, med ganske samme teknik som Björkebåden.
- containment hits: `anchor_5d9e995eec8`

### `Glostrup Kommune`  (single)
- path: `['developer']`
- note: unique p2; also appears in a modern-context paragraph (anchor_bda9d20317c) not acceptable as developer evidence
- gold `anchor_b9626568d28` (p2): I perioden 20-06-2016 til 01-07-2016 prøvegravede Kroppedal Museum et område vest for Sortevej i Hvissinge. Prøvegravningen var bestilt af Glostrup Kommune, der ønsker at byggemodne området. Den forløb over to uger, og afslørede de første tre grave (grav 1, 2 og 3). Da grav 1 og lerkarret i grav 2 allerede var meget eksponerede, var det nødvendigt, at udgrave disse i prøvegravningen. Forundersøgelsen viste, at der var velbevarede jernaldergrave på området, og museet indstillede derfor gravpladsen til egentlig udgravning. Denne forløb over 4½2 uge, fra 13-07-2016 til 15-08-2016.
- containment hits: `anchor_b9626568d28`, `anchor_bda9d20317c`

### `TV Lorry`  (single)
- path: `['media_coverage']`
- note: unique p4
- gold `anchor_23b8da0efab` (p4): omm d os o me ole i både lokalavisen og på den regionale TV-station, TV Lorry. Mange af de besøgende var tydeligvis lokale, der havde sommerferie i netop denne periode.
- containment hits: `anchor_23b8da0efab`

### `Morten Knudsen`  (MULTI-GOLD)
- path: `['excavation_participant']`
- note: REVIEW multi-gold: two figure captions
- gold `anchor_773b5fe2c12` (p5): Metode: det er et pillearbejde at rense skele er af ࢼ l foto. Morten Knudsen i fodenden af grav 6.
- gold `anchor_c27b812aa72` (p5): Metode: vi graver ikke al ࢼ d med ske og pensel. Der skal en stor maskine og en rolig hånd ࢼ l at fl y e de store sten, uden at ødelægge noget. Morten Knudsen og Arne Madsen i grav 3.
- containment hits: `anchor_773b5fe2c12`, `anchor_c27b812aa72`

### `år 1-400`  (single)
- path: `['boat_grave_dating']`
- note: unique p13
- gold `anchor_367c8a273ff` (p13): Hockergrave og fåreofre er typiske for ældre romersk jernalder, cirka år 1 til 200 efter vor tidssregning. Bådgravene har en bredere datering til romersk jernalder (år 1-400). Fiblerne i de to rige kvindegrave kan dateres mere præcist: fiblerne i grav 3 tilhører Almgrens gruppe V serie 5, som er typisk for perioden 50 til 150 efter vor tidsregning, mens fiblerne i grav 6 tilhører Almgrens gruppe Vsee 00 efter vor tidsregning. Hvis de to grave repræsenterer to generatont t r t0o
- containment hits: `anchor_367c8a273ff`

### `29`  (MULTI-GOLD)
- path: `['loose_feature_count']`
- note: REVIEW multi-gold: methods + results; bare number
- gold `anchor_d30fc0e8717` (p4): Udgravningen omfattede seks bevarede grave (inklusive de tre, der var påvist i prøvegravningen). Desuden fremkom i alt 29 løse anlæg, men ingen af de løse anlæg kunne relateres til hinanden, til gravene eller til større strukturer. De løse anlæg blev afrenset i fladen med ske og skovl, derefter snittet med ske og spade. Vi prioriterede snit i anlæggets længderetning, sekundært snit nord-syd med den østlige halvdel bortgravet, så snittet kunne ses fra øst. Hovedformålet med dette var at etablere, om der var tale om reelle anlæg fra oldtiden, om senere forstyrrelser, eller blot om naturlige variationer i undergrunden. I de tilfælde, hvor der var tale om reelle anlæg fra oldtiden, blev disse tegnet i profil i målestok 1:20. For gravene valgte vi en mere grundig og mere tidskrævende strategi. Vi afrensede alle de mulige grave i fladen med skovl og ske, og etablerede lokale målesystemer med søm, som senere blev indmålt med GPS. Vi tegnede anlæggene i fladen i 1:10. Herefter etablerede vi en 20 cm bred balk, nogenlunde vinkelret på nedgravningens længdeakse og nogenlunde midtvejs mellem gravens ender. Balkens placering kunne kun være nogenlunde, da det var vanskelligt at erkende gravenes præcise omrids så højt i jorden. Vi gravede os forsigtigt ned i vandrette lag, indtil vi enten observerede, at gravens synlige omrids ændrede sig markant, eller at der fremkom knogler eller fund. Hvis gravens synlige omrids ændrede sig markant, tegnede vi et nyt niveau i målestok 1:10. Hvis der fremkom knogler eller fund, boltlagde vi forsigtigt disse, hoved-
- gold `anchor_68434d38cc2` (p6): Udgravningen omfattede 29 løse anlæg og seks grave. Ingen af de løse anlæg kunne relateres til grave eller større strukturer. De løse anlæg omfatter nogle få kogestensgruber, og et større antal gruber, som ikke kan dateres nærmere end oldtid. Desuden fremkom et enkelt stolpehul, helt ude i prøvegravningens vestlige udkant og lige op ad et nuværende matrikelskel. Dette stolpehul kan stamme fra oldtiden, men det kan også stamme fra et hegn fra nyere tid. Det indgik ikke i nogen struktur indenfor prøvegravningens areal. På den baggrund konkluderede vi, at gravpladsen var afgrænset til sydenden af den relevante mark: vi havde prøvegravet de tilgrænsende marker mod syd og øst, og nordenden af marken, uden at finde grave eller nævneværdig aktivitet fra oldtiden. Vi udgravede seks jordfæstegrave. To af disse var bådgrave med dyreofre (grav 3 og grav 6). I fem af de seks jordfæstegrave fandt vi bevaret keramik, i fire bevaret metal. Både dyreofrene og metaloldsagernes typer tyder på en datering til ældre romersk jernalder. Ud over de seks udgravede grave fandt vi løse knogler fra mindst to individer i bunkerne. Grav 1 lå ganske overfladisk, lige i overgangen mellem muld og undergrund, og det er ganske sandsynligt, at disse to individer ("grav" 7 og 8) var begravet i endnu mere overfladiske grave. Knoglerne er hårdt medtaget, og det er muligt, a ploven har haft fat i dem. Når gravene ligger så højt, er det i praksis umuligt at bevare dem på stedet.
- containment hits: `anchor_d30fc0e8717`, `anchor_68434d38cc2`

### `TAK 1729`  (ABSTAIN)
- path: `['journal_number']`
- note: ADVERSARIAL near-variant of TAK 1728; verified absent
- containment hits (must be empty): none

### `grav 12`  (ABSTAIN)
- path: `['records', 3, 'grave_id']`
- note: ADVERSARIAL: graves 1-9 referenced (numbering inconsistent); grav 12 verified absent
- containment hits (must be empty): none

### `Bo Jansen`  (ABSTAIN)
- path: `['report_author']`
- note: ADVERSARIAL misspelling of Bo Jensen; verified absent
- containment hits (must be empty): none

### `05-09-2016`  (ABSTAIN)
- path: `['trial_excavation_end']`
- note: ADVERSARIAL near-variant date; 01-08-2016 and 15-08-2016 exist, 05-09-2016 verified absent
- containment hits (must be empty): none

### `Roskilde Kommune`  (ABSTAIN)
- path: `['developer']`
- note: plain absent value (real developer is Glostrup Kommune)
- containment hits (must be empty): none


## katrinesminde — 23 claims

### `SBM1116`  (single)
- path: `['journal_number']`
- note: unique, title page
- gold `anchor_936759daa7a` (p1): SBM1116 Katrinesminde
- containment hits: `anchor_936759daa7a`

### `Merethe Schifter Christensen`  (MULTI-GOLD)
- path: `['excavation_leader']`
- note: REVIEW multi-gold: staff list p6 + front-page abstract
- gold `anchor_868bd0498cb` (p6): Den systematiske udgravning sluttede den 13. oktober 2009. Feltarbejdet blev udført af arkæolog Merethe Schifter Christensen (daglig udgravningsleder) , arkæolog Louise Søndergaard og arkæolog Anja Vegebjerg Jensen. Alle ansat ved Skanderborg Museum. Den øvrige sagsbehandling blev foretaget af museumsinspektør Helle Reinholdt og arkæolog Ejvind Hertz, Skanderborg Museum.
- gold `anchor_f4cec97caf0` (p1): Beretning for udgravning af dyrkningstruet gravplads fra ældre romertid mellem Ry og Gl. Rye. Der dukkede 11 grave op fra ældre romertid samt to mulige grave fra enkeltgravskulturen. Desuden blev der afdækket vestenden af et hus fra ældre bronzealder samt flere anlægsspor der muligvis kan dateres til bronzealder. Daglig leder Merethe Schifter Christensen, Skanderborg Museum i september-oktober 2009.
- containment hits: `anchor_f4cec97caf0`, `anchor_868bd0498cb`

### `Louise Søndergaard`  (single)
- path: `['records', 0, 'archaeologist']`
- note: unique p6
- gold `anchor_868bd0498cb` (p6): Den systematiske udgravning sluttede den 13. oktober 2009. Feltarbejdet blev udført af arkæolog Merethe Schifter Christensen (daglig udgravningsleder) , arkæolog Louise Søndergaard og arkæolog Anja Vegebjerg Jensen. Alle ansat ved Skanderborg Museum. Den øvrige sagsbehandling blev foretaget af museumsinspektør Helle Reinholdt og arkæolog Ejvind Hertz, Skanderborg Museum.
- containment hits: `anchor_868bd0498cb`

### `Anja Vegebjerg Jensen`  (single)
- path: `['records', 1, 'archaeologist']`
- note: unique p6
- gold `anchor_868bd0498cb` (p6): Den systematiske udgravning sluttede den 13. oktober 2009. Feltarbejdet blev udført af arkæolog Merethe Schifter Christensen (daglig udgravningsleder) , arkæolog Louise Søndergaard og arkæolog Anja Vegebjerg Jensen. Alle ansat ved Skanderborg Museum. Den øvrige sagsbehandling blev foretaget af museumsinspektør Helle Reinholdt og arkæolog Ejvind Hertz, Skanderborg Museum.
- containment hits: `anchor_868bd0498cb`

### `René D. Jensen`  (single)
- path: `['machine_operator']`
- note: unique p5
- gold `anchor_4d990a5f52f` (p5): Muldafrømningen fandt sted fra den 1.-3. september 2009 og blev udført af KM Maskiner. Der blev anvendt en gravemaskine på larvebånd med to meter bred skovl. Maskinen blev ført af René D. Jensen. Tildækning af arealet fandt sted primo november og udført af KM Maskiner ved brug af en dozer.
- containment hits: `anchor_4d990a5f52f`

### `13. oktober 2009`  (single)
- path: `['excavation_end']`
- note: unique p6
- gold `anchor_868bd0498cb` (p6): Den systematiske udgravning sluttede den 13. oktober 2009. Feltarbejdet blev udført af arkæolog Merethe Schifter Christensen (daglig udgravningsleder) , arkæolog Louise Søndergaard og arkæolog Anja Vegebjerg Jensen. Alle ansat ved Skanderborg Museum. Den øvrige sagsbehandling blev foretaget af museumsinspektør Helle Reinholdt og arkæolog Ejvind Hertz, Skanderborg Museum.
- containment hits: `anchor_868bd0498cb`

### `2529 m2`  (single)
- path: `['field_area']`
- note: unique p7
- gold `anchor_2c90234c21b` (p7): Der er i forbindelse med undersøgelsen af gravpladsen åbnet et felt på 2529 m2. Feltets udbredelse og størrelse er vurderet ud fra forundersøgelsen, terrænforhold og de magnetometriske opmålinger. Ved afrømningen søgtes gravpladsen afgrænset så der min. var 10 meter fra den yderste grav og ud til feltgrænsen. Dette er opfyldt med undtagelse mod vest, hvor det havde været bedre om der var trukket et par meter længere ud for at være helt sikker. Dog falder terrænet noget deromkring, så det antages at gravpladsen alligevel er afgrænset. Gravpladsen synes at befinde sig på en naturlig højning i landskabet. Selvom det kun drejer sig om en halv meter i forhold til øvrig plateau, ses den tydeligt i landskabet.
- containment hits: `anchor_2c90234c21b`

### `116`  (single)
- path: `['total_feature_count']`
- note: results overview p8
- gold `anchor_5560879bdef` (p8): Der fremkom i alt 116 anlæg, heraf 11 grave fra ældre romertid, 2 grave fra ældre enkeltgravskultur, 88 stolpehuller, 3 gruber, 5 kogestensgruber, 3 anlæg som ikke var tolkbare og 3 der udgik. Heraf blev kun de dyrkningstruede grave undersøgt, samt enkelte gravlignende anlæg.
- containment hits: `anchor_5560879bdef`

### `88`  (single)
- path: `['posthole_count']`
- note: results overview p8, bare number
- gold `anchor_5560879bdef` (p8): Der fremkom i alt 116 anlæg, heraf 11 grave fra ældre romertid, 2 grave fra ældre enkeltgravskultur, 88 stolpehuller, 3 gruber, 5 kogestensgruber, 3 anlæg som ikke var tolkbare og 3 der udgik. Heraf blev kun de dyrkningstruede grave undersøgt, samt enkelte gravlignende anlæg.
- containment hits: `anchor_5560879bdef`

### `75,5 m`  (single)
- path: `['fixpoint_elevation']`
- note: unique p5
- gold `anchor_7bb2600dce8` (p5): Det vertikale målesystem bestod af ét fixpunkt på Målepunkt 9 med en daglig aflæsning på 180. Målepunkt 9 ligger på 75,5 m o. DNN.
- containment hits: `anchor_7bb2600dce8`

### `X44`  (MULTI-GOLD)
- path: `['records', 2, 'find_number']`
- note: REVIEW multi-gold: figure caption p9 + description in A22 text p8
- gold `anchor_ae8ba8e09da` (p9): Figur 6 Det svajede bæger, X44, efter optagning.
- gold `anchor_8e310c1ff1c` (p8): Udover enkelte skår og afslag, var der stort set ingen uregelmæssigheder i fylden. Dog tre ca. 20x10 cm store sten blev fundet i A18. Disse sten blev fundet tæt på det nederste lag og under den ene var der tæt pakket med ca. 30 små flintafslag, X157, hvoraf minimum to kan refittes og et enkelt stammer fra en sleben flintgenstand, X156. A22 indeholdte til gengæld et helt svajet bæger, X44, som lå væltet på bunden af det øverste lag, altså ca. 60 cm over bundniveau. Bægeret kan dateres til ældre enkeltgravskultur. På grundlag af det hele bæger og anlæggets form formodes der at der er tale om en grav eller alternativt, en offergrube. Karrets høje placering over bunden kan tyde på at det er en ofring der først er sket på gravens overflade og som så siden er fulgt med ned ved gravsænkningen. Spørgsmålet er så hvorfor nedgravningen er så dyb, tilspidset og smal. En mulighed er at der i denne har ligget dele af en båd tilsvarende den som findes i A18 (jvf. nedenstående).
- containment hits: `anchor_8e310c1ff1c`, `anchor_ae8ba8e09da`

### `47`  (single)
- path: `['vessel_count']`
- note: 'i alt 47 kar' p15, bare number
- gold `anchor_61604d00261` (p15): Lerkar : Da lerkarrene endnu ikke er frempræpareret vil dette være en kortfattet gennemgang af de kar som allerede i udgravningen kunne identificeres. Foreløbig er der i alt 47 kar. Der er mellem 1 og 10 kar i hver grav. Ser vi på typerne fordeler de sig således: 9 vaser, 1-2 fodbægre, 14 skåle, 6 hankekopper, 7 hankekar og 2 fade. Derudover kan der muligvis udskilles et drikkebæger, X127. 6 kar kan ikke endnu identificeres grundet deres fragmenterede tilstand.
- containment hits: `anchor_61604d00261`

### `ca. 83 kg`  (single)
- path: `['slag_weight']`
- note: unique p18
- gold `anchor_6b6d1414f14` (p18): I A25 havde man åbenbart problemer med at få sten nok, da man yderligere havde smidt en del slaggerester, X65, i. I alt seks spande af 10 liter lå i graven. De vejede tilsammen ca. 83 kg.
- containment hits: `anchor_6b6d1414f14`

### `X118`  (single)
- path: `['records', 3, 'find_number']`
- note: musling p17
- gold `anchor_ad6c01b6a27` (p17): Zoologisk materiale og småsten : En musling, X118, lå ved siden af den store ravperle i A24. Muslingen er endnu ikke undersøgt, men det formodes at der er tale om en lille amulet som sammen med ravperlen har været fastspændt bæltet. Lidt øst for muslingen og perlen lå to mindre sten som var glatte. Stenene er desværre ikke hjemtaget. Det anses som sandsynligt at stenene, muslingen og ravperlen kan have ligget i en skindpose eller lignende, som var fastspændt bæltet. Diverse genstande fra gravfylden : I gravenes fyld dukkede der ind imellem genstande op, som for størsteparten stammer fra romertiden. Dog er der i enkelte grave fundet bopladsaffald fra stenalderpladsen
- containment hits: `anchor_ad6c01b6a27`

### `Peter Jensen`  (single)
- path: `['threed_visualization_by']`
- note: unique p6
- gold `anchor_e4405369f2b` (p6): I øvrigt blev der eksperimenteret lidt med 3Dvisning af en grav, A24. Peter Jensen fra Moesgård Museum stod for dette.
- containment hits: `anchor_e4405369f2b`

### `26-11-2009`  (single)
- path: `['report_date']`
- note: unique p22, numeric date
- gold `anchor_e9d01929435` (p22): Skanderborg Museum d. 26-11-2009
- containment hits: `anchor_e9d01929435`

### `Adelgade 5`  (single)
- path: `['museum_address']`
- note: unique p5
- gold `anchor_f6cfd3b8c2c` (p5): Dokumentationsmateriale bestående af fund, fotos, tegninger og beretning opbevares på Skanderborg Museum, Adelgade 5, 8660 Skanderborg
- containment hits: `anchor_f6cfd3b8c2c`

### `7,73 %`  (single)
- path: `['regional_glass_bead_rate']`
- note: unique p20
- gold `anchor_797362f97eb` (p20): I Århus og Skanderborg gl. amter er der fundet glasperler i 7,73 % af gravene (for både B1 og B2). På Katrinesminde findes perlerne i 55 % af gravene. Dette kan selvfølgelig skyldes at der er forskelle på anvendelse af sold på de forskellige gravninger. Dog er det svært at se bort fra den store procentstigning af perler på Katrinesminde, hvilket ikke udelukkende kan skyldes manglen på erkendelse af perlerne i felten.
- containment hits: `anchor_797362f97eb`

### `SBM1117`  (ABSTAIN)
- path: `['journal_number']`
- note: ADVERSARIAL near-variant of SBM1116; verified absent
- containment hits (must be empty): none

### `X119`  (ABSTAIN)
- path: `['records', 3, 'find_number']`
- note: ADVERSARIAL: X117/X118 exist, X119 verified absent
- containment hits (must be empty): none

### `Merethe Schifter Bagge`  (ABSTAIN)
- path: `['excavation_leader']`
- note: ADVERSARIAL cross-document name confusion (leader here is Christensen); verified absent
- containment hits (must be empty): none

### `14. oktober 2009`  (ABSTAIN)
- path: `['excavation_end']`
- note: ADVERSARIAL near-date of 13. oktober 2009; verified absent
- containment hits (must be empty): none

### `Nationalmuseet`  (ABSTAIN)
- path: `['conservation_institution']`
- note: plain absent value (conservation is at Moesgård)
- containment hits (must be empty): none

## Warnings (containment/gold mismatches — human review required)

- age-related-disease: `Kiel University` golds without hits: none; non-gold hits: anchor_c3eb2c0cdf3; note: affiliation a; acknowledgments also mention Kiel University (anchor_c3eb2c0cdf3) but as funding host, not an author affiliation
- age-related-disease: `Im Dol 2-6` golds without hits: anchor_773ccee8569; non-gold hits: none; note: gold text reads 'Im Dol 2 -6' (spaced dash) — deliberate paraphrase case, lexical must miss
- brondbylund: `18` golds without hits: none; non-gold hits: anchor_0318bfca7a2, anchor_21a801b4335, anchor_dbbc4c7a5fd; note: hard: bare number; source says 'mindst 18 treskibede langhuse'
- catfish-collagen: `Carlos José Dias Pereira` golds without hits: anchor_281439a9f96; non-gold hits: none; note: OCR reads 'Jos é' with split accent — lexical must miss, neural must catch
- catfish-collagen: `GACGCTGTATGTGAAACGGC` golds without hits: anchor_8d86be60f2f; non-gold hits: none; note: REVIEW multi-gold: col1a1-R row label anchor (table context) + sequence anchor
- catfish-collagen: `TATCTCCCCTTGGTCCCGAT` golds without hits: anchor_4faa09e9a48; non-gold hits: none; note: REVIEW multi-gold: col1a2-R row label anchor (table context) + sequence anchor
- ellekilde: `Yngre romersk jernalder per. C3` golds without hits: none; non-gold hits: anchor_504ddb27457; note: REVIEW: substring also in grave 26's dating anchor_504ddb2; gold = grave 24's dating line
- ellekilde: `15` golds without hits: none; non-gold hits: anchor_479591a0055, anchor_75304c9b7fe, anchor_f6c4c4a53f1, anchor_f9c02eb1de9; note: hard: bare number, lexically ambiguous everywhere; source says 'i alt 15 tænder'
- free-ports-hamburg: `Cambridge University Press` golds without hits: none; non-gold hits: anchor_2e482f1f38f, anchor_474e09f4298, anchor_48a484b80e5, anchor_5ab1622aae4, anchor_6982be468fc, anchor_6f1997430ce, anchor_d9031215d13, anchor_fafa63c9b66; note: hard: 9 lexical hits (many footnote citations); gold = the © / open-access statement
- free-ports-hamburg: `1591` golds without hits: none; non-gold hits: anchor_bd257a4cdd6; note: REVIEW: 2 hits; gold = Livorno year cell in table 1; claim is for Livorno row
- free-ports-hamburg: `Livorno` golds without hits: none; non-gold hits: anchor_13b73f19f3b, anchor_1631b6f6eed, anchor_26e7bd9a373, anchor_3814c039331, anchor_7814dcf44bc, anchor_8b0bd48adda, anchor_c829a9e20d7, anchor_d55b6c1b8ba, anchor_fc0726eda10, anchor_fee70e68426; note: hard: 11 lexical hits across prose/footnotes; gold = table 1 port cell
- free-ports-hamburg: `1766` golds without hits: none; non-gold hits: anchor_0bfed4de2c0, anchor_10fd553e04d, anchor_13361442296, anchor_13b73f19f3b, anchor_3c1ad3ac3d8, anchor_3f2484f4ec0, anchor_73bd442e84f, anchor_a509e89f566, anchor_e074254080c, anchor_e415399105d, anchor_ff608eaf4a3; note: was KNOWN-HARD (identical year cells) — row context should now disambiguate
- herredsvejen: `23-09-2019` golds without hits: anchor_036fde44f39, anchor_d33917c2342; non-gold hits: none; note: REVIEW multi-gold: campaign line (numeric), sagsgang entry, period sentence
- herredsvejen: `1300 m2` golds without hits: anchor_9f47ea13623; non-gold hits: none; note: written '1300m2' without space in the document — lexical should miss
- hojbakkegaard: `ca. 400 e.Kr.` golds without hits: none; non-gold hits: anchor_8026bbc53f5; note: REVIEW: 2 hits (grave 6 prose anchor_8026bbc, grave 9 dating line); claim is for grave 9 -> gold anchor_4cb663f
- hojbakkegaard: `2004-08-13` golds without hits: anchor_143c9746911; non-gold hits: none; note: hard: ISO date vs '13. august 2004' (month name) — lexical cannot match, neural tier must
- hvissinge: `58 cm` golds without hits: none; non-gold hits: anchor_63679bcf2d6; note: unique p10; '58 cm' also appears in the Slusegard/Egholm comparison (anchor_63679bcf2d6) which is NOT evidence for the Hvissinge boat
- hvissinge: `Glostrup Kommune` golds without hits: none; non-gold hits: anchor_bda9d20317c; note: unique p2; also appears in a modern-context paragraph (anchor_bda9d20317c) not acceptable as developer evidence

OK: 10 doc(s) validated, 18 warning(s)
