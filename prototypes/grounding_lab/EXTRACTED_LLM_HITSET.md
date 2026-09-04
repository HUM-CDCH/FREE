# Policy E with the LLM as hit-set scorer, on the extractor-output labels

> Same contract as E's reranker: field name, sibling context, and only the
> lexical hit set as candidates (`grounding_lab.llm_hitset`, protocol in its
> module docstring). `qwen3.8:latest` (27B Q4, local Ollama,
> thinking on), 2026-09-04, `--claims claims_extracted.json`. Single hits link
> and zero hits abstain without a model call, as in E; the model may answer
> NONE inside a hit set, which E-Nemotron at frozen thresholds cannot.

Against E-Nemotron on the same 360 claims (frozen thresholds: 230 correct,
61 wrong, 35 review; leave-one-document-out: 234 correct, 41 wrong): 251
correct, 36 wrong, no review bucket, 5.2 s per claim against 28 ms.

## Policy E with qwen3.8:latest as the hit-set scorer

| set | claims | correct links | correct abstains | wrong links | protocol failures | model calls | avg ms/claim |
|---|---:|---:|---:|---:|---:|---:|---:|
| final_dataset_3 | 360 | 168/256 | 83/104 | 36 | 0 | 195 | 5238 |
| **pooled** | 360 | 168/256 | 83/104 | 36 | 0 | 195 | 5238 |

### Per-claim audit

| doc | claim | hits | tier | pick |
|---|---|---:|---|---|
| buchvaldek-1970-vikletice-tables-de | Vikletice | 17 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Hammeräxte | 24 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Hammeräxte | 24 | llm | ✗ anchor_7521736470c |
| buchvaldek-1970-vikletice-tables-de | E | 3 | llm | ✓ anchor_4ba5b52a115 |
| buchvaldek-1970-vikletice-tables-de | 300 | 4 | llm | ✓ anchor_d65361c51bd |
| buchvaldek-1970-vikletice-tables-de | Hammeräxte | 24 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Hammeräxte | 24 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | L | 13 | llm | ✓ anchor_cdcdb3d8e33 |
| buchvaldek-1970-vikletice-tables-de | 240 | 3 | llm | ✓ anchor_a7831f8c84f |
| buchvaldek-1970-vikletice-tables-de | Keulenköpfe | 15 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 30 | 169 | llm | ✓ anchor_aa16331d2a6 |
| buchvaldek-1970-vikletice-tables-de | stark korrodiert | 3 | llm | ✓ anchor_0e555ee8b2c |
| buchvaldek-1970-vikletice-tables-de | 140 | 17 | llm | ✓ anchor_616fa48370e |
| buchvaldek-1970-vikletice-tables-de | Keulenköpfe | 15 | llm | ✗ anchor_9e5dd46d4b4 |
| buchvaldek-1970-vikletice-tables-de | Keulenköpfe | 15 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Beile (BL 1) | 1 | lexical | ✓ anchor_0db6c8b3df4 |
| buchvaldek-1970-vikletice-tables-de | Schmalseiten grob bearbeitet, Oberflä… | 1 | lexical | ✓ anchor_96416b25f5d |
| buchvaldek-1970-vikletice-tables-de | 80 | 50 | llm | ✓ anchor_f9eba18218c |
| buchvaldek-1970-vikletice-tables-de | A | 54 | llm | ✓ anchor_cb85e46d72a |
| buchvaldek-1970-vikletice-tables-de | Oberfläche z. T. facettiert? Schneide… | 1 | lexical | ✓ anchor_d7da472fa48 |
| buchvaldek-1970-vikletice-tables-de | A | 54 | llm | ✓ anchor_9775604ea8e |
| buchvaldek-1970-vikletice-tables-de | A | 54 | llm | ✓ anchor_1cea144b0c7 |
| buchvaldek-1970-vikletice-tables-de | A | 54 | llm | ✓ anchor_446cd73da22 |
| buchvaldek-1970-vikletice-tables-de | 200 | 9 | llm | ✓ anchor_63b7ef828a6 |
| buchvaldek-1970-vikletice-tables-de | 190 | 13 | llm | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Breitseiten z. T. konkav geschliffen;… | 1 | lexical | ✓ anchor_f8c738a11ce |
| buchvaldek-1970-vikletice-tables-de | 140 | 17 | llm | ✓ anchor_6e3510c99ce |
| buchvaldek-1970-vikletice-tables-de | A | 54 | llm | ✓ anchor_a9df0328c4f |
| buchvaldek-1970-vikletice-tables-de | 120 | 27 | llm | ✓ anchor_6f19b9cc366 |
| buchvaldek-1970-vikletice-tables-de | A | 54 | llm | ✓ anchor_c267bd31d02 |
| buchvaldek-1970-vikletice-tables-de | 200 | 9 | llm | ✓ anchor_1cea25ab389 |
| buchvaldek-1970-vikletice-tables-de | 1110 | 2 | llm | ✓ anchor_ffc7f97ec67 |
| buchvaldek-1970-vikletice-tables-de | Beile (BL 2) | 3 | llm | ✓ anchor_09b406962c7 |
| buchvaldek-1970-vikletice-tables-de | Beile (BL 2) | 3 | llm | ✓ anchor_09b406962c7 |
| buchvaldek-1970-vikletice-tables-de | Ganz geschliffene Oberfläche. | 2 | llm | ✓ anchor_13b3e832a49 |
| buchvaldek-1970-vikletice-tables-de | 40 | 72 | llm | ✓ anchor_b978830647d |
| buchvaldek-1970-vikletice-tables-de | Schleifsteine | 5 | llm | ✗ anchor_91c9c07b620 |
| buchvaldek-1970-vikletice-tables-de | J - mittel bis grobkörniger verkiesel… | 4 | llm | ✗ anchor_de7445f26d4 |
| buchvaldek-1970-vikletice-tables-de | 470 | 2 | llm | ✓ anchor_7500fb35aa2 |
| buchvaldek-1970-vikletice-tables-de | 130 | 18 | llm | ✓ anchor_f2494f82bd4 |
| buchvaldek-1970-vikletice-tables-de | Pfriem? (derzeit nicht nachprüfbar) | 1 | lexical | ✓ anchor_9b71f043f50 |
| buchvaldek-1970-vikletice-tables-de | Pfriem? | 7 | llm | ✓ anchor_33fc476bb87 |
| buchvaldek-1970-vikletice-tables-de | Knochengeräte | 2 | llm | ✗ anchor_05740359e5c |
| buchvaldek-1970-vikletice-tables-de | Hausrind | 1 | lexical | ✓ anchor_9d2e3fc1fec |
| buchvaldek-1970-vikletice-tables-de | Schaf oder Ziege | 3 | llm | ✗ anchor_3e52a06fbdb |
| buchvaldek-1970-vikletice-tables-de | Muschel | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Marmoranhänger | 1 | lexical | ✓ anchor_052ba1423c2 |
| buchvaldek-1970-vikletice-tables-de | Tierzahnschmuck | 3 | llm | ✗ anchor_1f25d371e5a |
| buchvaldek-1970-vikletice-tables-de | Tierzahnschmuck | 3 | llm | ✗ anchor_1f25d371e5a |
| buchvaldek-1970-vikletice-tables-de | etwa 11 Stück, in einer Reihe? | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Tierzähne | 3 | llm | ✗ anchor_1f25d371e5a |
| buchvaldek-1970-vikletice-tables-de | etwa 64(27) Stück, verstreut | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Tierzahnschmuck | 3 | llm | ✗ anchor_1f25d371e5a |
| buchvaldek-1970-vikletice-tables-de | Spiralröllchen I, 0 17 mm, rechtsgewu… | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Kupferschmuck | 3 | llm | ✗ anchor_38fd6af944c |
| buchvaldek-1970-vikletice-tables-de | Kupfer | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 3 - 4 Perlen, 2 ganze Perlen, eine 0 … | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Spiralröllchen, 5 Bruchstücke eines (… | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | Kupferschmuck | 3 | llm | ✗ anchor_38fd6af944c |
| buchvaldek-1970-vikletice-tables-de | Kupfer | 0 | lexical | ✗ — |
| buchvaldek-koutecky-1972-vikletice-de | D. Koutecký | 1 | lexical | ✓ anchor_4d004d59588 |
| buchvaldek-koutecky-1972-vikletice-de | 5 | 59 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A27a | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A27m | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A28g | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A30b | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A30e | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A32c | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A33e | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A34e | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A34l | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A34v | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A35r | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A36n | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A36u | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A37a | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A38r | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A40n | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A41d | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A41r | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A42f | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A43s | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A44l | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A44s | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A45c | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A46e | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A46i | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A48q | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A48r | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 2 | 127 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | A49u | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Archäologische Grabungsberichte: Mark… | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Grab 3 (Bef. 22) | 1 | lexical | ✓ anchor_7112f510127 |
| conrad-2011-bbc-graves-de | Abb. 49 | 1 | lexical | ✓ anchor_7112f510127 |
| conrad-2011-bbc-graves-de | Grab 1 (Bef. 547/548) | 1 | lexical | ✓ anchor_7b343a7d24c |
| conrad-2011-bbc-graves-de | 416.3 | 1 | lexical | ✗ anchor_ce240ffb570 |
| conrad-2011-bbc-graves-de | Verz. Glockenbecher | 16 | llm | ✗ — |
| conrad-2011-bbc-graves-de | Unverz. Gefäß | 1 | lexical | ✓ anchor_1eeda3e569d |
| conrad-2011-bbc-graves-de | Scherben (BS, WS, RS) | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Pfostengrube 1 (Bef. 546) | 1 | lexical | ✓ anchor_4bd9d162893 |
| conrad-2011-bbc-graves-de | Rotlehmfragmente | 2 | llm | ✗ anchor_c9a59002a73 |
| conrad-2011-bbc-graves-de | Pfostengrube 2 (Bef. 549) | 1 | lexical | ✓ anchor_694b2662dc0 |
| conrad-2011-bbc-graves-de | Abb. 50 | 5 | llm | ✓ anchor_694b2662dc0 |
| conrad-2011-bbc-graves-de | Pfostengrube 3 (Bef. 550) | 1 | lexical | ✓ anchor_5d346986e75 |
| conrad-2011-bbc-graves-de | Pfostengrube 4 (Bef. 551) | 1 | lexical | ✓ anchor_7ce33ed5068 |
| conrad-2011-bbc-graves-de | Abb. 50 | 5 | llm | ✓ anchor_7ce33ed5068 |
| conrad-2011-bbc-graves-de | Grab 1 (Bef. 95-186/24) | 1 | lexical | ✓ anchor_8d900ed9d4a |
| conrad-2011-bbc-graves-de | 1497.1 | 1 | lexical | ✓ anchor_598625f5809 |
| conrad-2011-bbc-graves-de | Verz. Glockenbecher | 16 | llm | ✓ anchor_598625f5809 |
| conrad-2011-bbc-graves-de | 2 Bernsteinperlenfragmente | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | 5 Pfeilspitzen (Silex, verkieselter S… | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Silexklinge | 23 | llm | ✗ — |
| conrad-2011-bbc-graves-de | Silexabschläge | 15 | llm | ✗ — |
| conrad-2011-bbc-graves-de | 2 Pfeilschaftglätter | 0 | lexical | ✗ — |
| conrad-2011-bbc-graves-de | 2 Hämmer | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Abb. 51; 52 | 1 | lexical | ✓ anchor_8d900ed9d4a |
| conrad-2011-bbc-graves-de | Befund 1 (Bef. 95-186/3) | 1 | lexical | ✓ anchor_acccc34aeb9 |
| conrad-2011-bbc-graves-de | 2 verz. Glockenbecher | 1 | lexical | ✗ anchor_dadd7fbd6cf |
| conrad-2011-bbc-graves-de | Scherben (verz. und unverz.) | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Silexklinge | 23 | llm | ✓ — |
| conrad-2011-bbc-graves-de | Abb. 53 | 3 | llm | ✓ anchor_acccc34aeb9 |
| conrad-2011-bbc-graves-de | Grab 2 (Bef. 96-187/1) | 1 | lexical | ✓ anchor_c0a4f530494 |
| conrad-2011-bbc-graves-de | Organischer Gefäßinhalt (Teerartig) | 0 | lexical | ✗ — |
| conrad-2011-bbc-graves-de | Grab 3 (Bef. 98-195/7) | 1 | lexical | ✓ anchor_fafdc1c1448 |
| conrad-2011-bbc-graves-de | Verz. krugähnliches Gefäß mit Öse | 1 | lexical | ✓ anchor_b954dcbf5f3 |
| conrad-2011-bbc-graves-de | Silexklinge | 23 | llm | ✗ — |
| conrad-2011-bbc-graves-de | Abb. 53; 54 | 1 | lexical | ✓ anchor_fafdc1c1448 |
| conrad-2011-bbc-graves-de | Grab 4 (Bef. 96-186/9) | 1 | lexical | ✓ anchor_72521184ea9 |
| conrad-2011-bbc-graves-de | Abb. 54 | 1 | lexical | ✓ anchor_72521184ea9 |
| conrad-2011-bbc-graves-de | Grab 5 (Bef. 96-187/5) | 1 | lexical | ✓ anchor_c126d52e72b |
| conrad-2011-bbc-graves-de | Abb. 55 | 1 | lexical | ✓ anchor_c126d52e72b |
| conrad-2011-bbc-graves-de | Grab 1 (Bef. 128) | 1 | lexical | ✓ anchor_d07a4e6fd75 |
| conrad-2011-bbc-graves-de | Unverz. Standringschale | 1 | lexical | ✓ anchor_80e0ce25302 |
| conrad-2011-bbc-graves-de | Silexabschlag | 16 | llm | ✓ — |
| conrad-2011-bbc-graves-de | Abb. 56 | 6 | llm | ✓ anchor_d07a4e6fd75 |
| conrad-2011-bbc-graves-de | Silexklinge | 23 | llm | ✗ — |
| conrad-2011-bbc-graves-de | Abb. 56 | 6 | llm | ✓ anchor_89c2b0cb383 |
| conrad-2011-bbc-graves-de | Einzelfund aus früheisenzeitlichem Be… | 1 | lexical | ✓ anchor_afc6f4e57cc |
| conrad-2011-bbc-graves-de | WS, verz. (Leitermotiv) | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Abb. 56 | 6 | llm | ✓ anchor_afc6f4e57cc |
| conrad-2011-bbc-graves-de | WS, verz. (Band mit senkrechten Linien) | 0 | lexical | ✗ — |
| conrad-2011-bbc-graves-de | Abb. 56 | 6 | llm | ✓ anchor_b9e065b97b0 |
| conrad-2011-bbc-graves-de | 2007 | 0 | lexical | ✗ — |
| conrad-2011-bbc-graves-de | WS, verz. (Band mit Vierecken) | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | Abb. 56 | 6 | llm | ✓ anchor_3b0a77fc9fa |
| conrad-2011-bbc-graves-de | Einzelfund bei Feldbegehung am 24.09.… | 1 | lexical | ✓ anchor_19f215f5c8f |
| conrad-2011-bbc-graves-de | 2006 | 0 | lexical | ✗ — |
| conrad-2011-bbc-graves-de | RS, verz. (Band mit senkrechten Stemp… | 1 | lexical | ✓ anchor_9e16d3f2e8c |
| conrad-2011-bbc-graves-de | Abb. 56 | 6 | llm | ✓ anchor_19f215f5c8f |
| conrad-2011-bbc-graves-de | Grab 1 (Bef. 30) | 1 | lexical | ✓ anchor_19f72772f29 |
| conrad-2011-bbc-graves-de | Verz. Glockenbecher | 16 | llm | ✗ — |
| dobes-1998-kugelamphoren-de | Die Westgruppe der Kugelamphorenkultu… | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | M. Dobeš (abgeleitet aus den Zitation… | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Kr. Teplice | 3 | llm | ✓ anchor_cdf2701ac2c |
| dobes-1998-kugelamphoren-de | Nová Ves bei Brandýs | 2 | llm | ✓ anchor_36f6012fc1e |
| dobes-1998-kugelamphoren-de | Blšany | 10 | llm | ✓ anchor_03e894acbe4 |
| dobes-1998-kugelamphoren-de | Prag-Šárka | 1 | lexical | ✓ anchor_622543792a7 |
| dobes-1998-kugelamphoren-de | Brozany nad Ohří | 4 | llm | ✓ anchor_3d666c5234e |
| dobes-1998-kugelamphoren-de | Homolka bei Stehelčeves | 2 | llm | ✓ anchor_0058b4a1892 |
| dobes-1998-kugelamphoren-de | Nymburk (Umgebung) | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Klučov | 1 | lexical | ✓ anchor_a84cce56ee1 |
| dobes-1998-kugelamphoren-de | Kutná Hora ('Dänemark') | 1 | lexical | ✓ anchor_a84cce56ee1 |
| dobes-1998-kugelamphoren-de | Kr. Chomutov | 2 | llm | ✓ anchor_a4e32e16822 |
| dobes-1998-kugelamphoren-de | Velemyšleves | 2 | llm | ✓ anchor_1814cd024d5 |
| dobes-1998-kugelamphoren-de | Velké Zernoseky | 1 | lexical | ✓ anchor_a4e32e16822 |
| dobes-1998-kugelamphoren-de | Kr. Litoměřice | 7 | llm | ✓ anchor_a4e32e16822 |
| dobes-1998-kugelamphoren-de | Kopisty | 1 | lexical | ✓ anchor_a4e32e16822 |
| dobes-1998-kugelamphoren-de | Hrdly | 9 | llm | ✓ anchor_422a126fd8f |
| dobes-1998-kugelamphoren-de | Baalberg | 2 | llm | ✓ anchor_52ac4421ae8 |
| dobes-1998-kugelamphoren-de | Halle-Dölauer Heide | 1 | lexical | ✓ anchor_60f7791efd0 |
| dobes-1998-kugelamphoren-de | Altenburg | 1 | lexical | ✓ anchor_60f7791efd0 |
| dobes-1998-kugelamphoren-de | Weißandt-Gölzau | 0 | lexical | ✗ — |
| dobes-1998-kugelamphoren-de | Ostedt | 1 | lexical | ✓ anchor_8a8de166ad6 |
| dobes-1998-kugelamphoren-de | Menz | 3 | llm | ✓ anchor_bf3ed1b5d33 |
| dobes-1998-kugelamphoren-de | Ldkr. Stendal | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Pevestorf | 2 | llm | ✓ anchor_bf3ed1b5d33 |
| dobes-1998-kugelamphoren-de | Zachow | 2 | llm | ✗ anchor_7a89e0790e7 |
| dobes-1998-kugelamphoren-de | Dahme | 1 | lexical | ✓ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Kirchmöser | 1 | lexical | ✓ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Mützlitz | 1 | lexical | ✓ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Schmiedeberg | 1 | loose | ✗ — |
| dobes-1998-kugelamphoren-de | Brandenburg-Altstadt | 1 | lexical | ✓ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Dedelow | 1 | lexical | ✓ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Flieht | 1 | lexical | ✓ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Benzingerode | 2 | llm | ✗ anchor_db33b95c94e |
| dobes-1998-kugelamphoren-de | Kr. Wernigerode | 1 | lexical | ✗ anchor_db33b95c94e |
| dobes-1998-kugelamphoren-de | Starý Zámek bei Jevišovice | 1 | lexical | ✓ anchor_ef145641fa3 |
| dobes-1998-kugelamphoren-de | Hrádek u Čáslavi | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | okr. Teplice | 1 | lexical | ✗ anchor_d11ef4570f3 |
| dobes-1998-kugelamphoren-de | Kamýk | 1 | lexical | ✓ anchor_b14450317c2 |
| dobes-1998-kugelamphoren-de | Velvary | 1 | lexical | ✓ anchor_b785a9b5310 |
| dobes-1998-kugelamphoren-de | Cítolib | 1 | lexical | ✗ anchor_08d2038d9ab |
| dobes-1998-kugelamphoren-de | Bez. Kaaden | 1 | lexical | ✗ anchor_8fac6ec9ec8 |
| dobes-1998-kugelamphoren-de | Podersam (Berg Rubin) | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Neratovice (Chemie-Kombinat Spolany) | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Vraný | 4 | llm | ✗ — |
| dobes-1998-kugelamphoren-de | na Slánsku | 1 | lexical | ✗ anchor_4eae820849f |
| dobes-1998-kugelamphoren-de | okr. Praha-východ | 1 | lexical | ✗ anchor_7fd5b628567 |
| dobes-1998-kugelamphoren-de | Zámků u Bohnic | 2 | llm | ✗ anchor_f9b941a4f45 |
| dobes-1998-kugelamphoren-de | Praha 5-Zličov | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Litoměřice | 10 | llm | ✓ — |
| dobes-1998-kugelamphoren-de | Teplice (Museum) | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Kr. Weimar | 1 | lexical | ✗ anchor_bb28485cc73 |
| dobes-1998-kugelamphoren-de | Niedersachsen | 8 | llm | ✗ anchor_3734be6e784 |
| dobes-1998-kugelamphoren-de | Altmark | 6 | llm | ✗ anchor_bf3ed1b5d33 |
| dobes-1998-kugelamphoren-de | Uckermark | 1 | lexical | ✗ anchor_8eeccdd9ea9 |
| dobes-1998-kugelamphoren-de | Nordwestböhmen | 21 | llm | ✗ anchor_5226359f325 |
| dobes-1998-kugelamphoren-de | Ostböhmen | 6 | llm | ✗ anchor_cfb070416e4 |
| dobes-1998-kugelamphoren-de | Schlesien | 3 | llm | ✗ anchor_bc7c46f5a9a |
| dobes-1998-kugelamphoren-de | Jütische Halbinsel | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Polska (Polen) | 0 | lexical | ✓ — |
| durankulak-catalogue-de | 1.1 | 2 | llm | ✗ — |
| durankulak-catalogue-de | Mature | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 55 | 61 | llm | ✗ — |
| durankulak-catalogue-de | 1.4 | 4 | llm | ✗ — |
| durankulak-catalogue-de | 1078 | 1 | lexical | ✓ anchor_45641182832 |
| durankulak-catalogue-de | Hamangia-Kultur | 759 | llm | ✓ anchor_9882687d748 |
| durankulak-catalogue-de | 1081 | 1 | lexical | ✓ anchor_486511c07b6 |
| durankulak-catalogue-de | Mature | 0 | lexical | ✗ — |
| durankulak-catalogue-de | Stufe III | 461 | llm | ✗ — |
| durankulak-catalogue-de | Tabl. 180,2; Tabl. 180,1 | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 1088 | 1 | lexical | ✓ anchor_917660bf04b |
| durankulak-catalogue-de | Tabl. 180,13; Tabl. 180,12; Tabl. 180,11 | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 1098 | 1 | lexical | ✓ anchor_40205451529 |
| durankulak-catalogue-de | 1100 | 1 | lexical | ✓ anchor_00e84a7acdc |
| durankulak-catalogue-de | 1104 | 1 | lexical | ✓ anchor_a319f7f318a |
| durankulak-catalogue-de | 1.14 | 7 | llm | ✓ anchor_0311acad060 |
| durankulak-catalogue-de | Tabl. 185,2 | 1 | lexical | ✓ anchor_eb17388abde |
| durankulak-catalogue-de | 1107 | 2 | llm | ✓ anchor_a0b58be73fa |
| durankulak-catalogue-de | 0.82 | 6 | llm | ✓ anchor_a7d9c2b1d5e |
| durankulak-catalogue-de | 40 | 169 | llm | ✗ — |
| durankulak-catalogue-de | Varna-Kultur | 417 | llm | ✗ — |
| durankulak-catalogue-de | Male | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 1.01 | 3 | llm | ✓ anchor_d938b2b289a |
| durankulak-catalogue-de | 1117 | 2 | llm | ✗ anchor_805f2796b5a |
| durankulak-catalogue-de | Varna-Kultur | 417 | llm | ✗ — |
| durankulak-catalogue-de | 1.42 | 3 | llm | ✓ anchor_2c47e3e1932 |
| durankulak-catalogue-de | 30 | 174 | llm | ✗ — |
| durankulak-catalogue-de | Varna-Kultur | 417 | llm | ✗ — |
| durankulak-catalogue-de | 1127 | 1 | lexical | ✓ anchor_f59179346e3 |
| durankulak-catalogue-de | 1.18 | 11 | llm | ✓ anchor_77312291cdc |
| durankulak-catalogue-de | Mature | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 1133 | 2 | llm | ✓ anchor_4fd5a0f9418 |
| durankulak-catalogue-de | Tabl. 188,3; Tabl. 188,2; Tabl. 188,4… | 0 | lexical | ✗ — |
| durankulak-catalogue-de | Varna-Kultur | 417 | llm | ✗ — |
| durankulak-catalogue-de | Mature | 0 | lexical | ✗ — |
| durankulak-catalogue-de | Varna-Kultur | 417 | llm | ✗ — |
| durankulak-catalogue-de | Hamangia-Kultur | 759 | llm | ✗ — |
| durankulak-catalogue-de | Tabl. 174,12 | 1 | lexical | ✓ anchor_b4ed81a174f |
| durankulak-catalogue-de | 0.48 | 8 | llm | ✓ anchor_88fa561f0e4 |
| durankulak-catalogue-de | 1146 | 1 | lexical | ✓ anchor_f0294df21b3 |
| durankulak-catalogue-de | Female | 0 | lexical | ✗ — |
| durankulak-catalogue-de | Male | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 1173 | 1 | lexical | ✓ anchor_80dd4548b23 |
| durankulak-catalogue-de | N | 3 | llm | ✗ — |
| durankulak-catalogue-de | 1.56 | 7 | llm | ✓ anchor_2719b14383e |
| durankulak-catalogue-de | N | 3 | llm | ✗ — |
| durankulak-catalogue-de | N | 3 | llm | ✗ — |
| durankulak-catalogue-de | Infant | 0 | lexical | ✗ — |
| durankulak-catalogue-de | 40 | 169 | llm | ✓ anchor_4ae452ddde9 |
| durankulak-catalogue-de | N | 3 | llm | ✗ — |
| durankulak-catalogue-de | Stufe III | 461 | llm | ✓ anchor_87efac6766c |
| durankulak-catalogue-de | 1190 | 1 | lexical | ✓ anchor_a6a53c502de |
| durankulak-catalogue-de | Mature | 0 | lexical | ✗ — |
| durankulak-catalogue-de | Stufen II-III | 107 | llm | ✗ — |
| durankulak-catalogue-de | 1194 | 2 | llm | ✗ anchor_39ebd070e4a |
| durankulak-catalogue-de | Varna-Kultur | 417 | llm | ✗ — |
| durankulak-catalogue-de | 1.43 | 6 | llm | ✓ anchor_9958a3227f3 |
| durankulak-catalogue-de | Stufe III | 461 | llm | ✓ anchor_409019da987 |
| durankulak-catalogue-de | 25 | 151 | llm | ✗ — |
| durankulak-catalogue-de | Stufe III | 461 | llm | ✗ — |
| shbat-2009-skeletal-health-en | SKELETAL HEALTH OF LATE NEOLITHIC POP… | 10 | llm | ✓ anchor_3e0b2e413bc |
| shbat-2009-skeletal-health-en | 195 | 0 | lexical | ✗ — |
| shbat-2009-skeletal-health-en | 150 | 3 | llm | ✗ anchor_572d5a4dbe8 |
| shbat-2009-skeletal-health-en | 0 | 26 | llm | ✗ anchor_b69d6892c4e |
| shbat-2009-skeletal-health-en | 1 | 32 | llm | ✓ anchor_9d77834eb96 |
| shbat-2009-skeletal-health-en | Kladno | 1 | lexical | ✓ anchor_0ef2bac096e |
| shbat-2009-skeletal-health-en | 21 | 10 | llm | ✓ anchor_133fd1066cd |
| shbat-2009-skeletal-health-en | 16 | 7 | llm | ✓ anchor_28fb876fded |
| shbat-2009-skeletal-health-en | 0 | 26 | llm | ✓ anchor_83382a7ddbe |
| shbat-2009-skeletal-health-en | 4/64 | 1 | lexical | ✓ anchor_3c491d989ea |
| shbat-2009-skeletal-health-en | SD of Thoracic Vertebrae Schmorl´s no… | 1 | lexical | ✓ anchor_34a149b7254 |
| shbat-2009-skeletal-health-en | F | 11 | llm | ✓ anchor_96ac0831ddb |
| shbat-2009-skeletal-health-en | 53/80-I | 1 | lexical | ✓ anchor_83d09b95a88 |
| shbat-2009-skeletal-health-en | Thoracic and Lumbar Vertebrae | 0 | lexical | ✓ — |
| shbat-2009-skeletal-health-en | M | 28 | llm | ✓ anchor_d787eea6bf8 |
| shbat-2009-skeletal-health-en | Lumbar Vertebrae | 2 | llm | ✓ — |
| shbat-2009-skeletal-health-en | Radovesice | 8 | llm | ✓ anchor_14fe29de33c |
| shbat-2009-skeletal-health-en | M | 28 | llm | ✓ anchor_66b63d6055a |
| shbat-2009-skeletal-health-en | SD Th 9 - 10 Schmorl´s Nodes (Th) | 1 | lexical | ✓ anchor_5a2c27ed2cd |
| shbat-2009-skeletal-health-en | Ao 1607 | 3 | llm | ✓ anchor_4f8229a635f |
| shbat-2009-skeletal-health-en | 45+ | 19 | llm | ✓ anchor_47116a63c23 |
| shbat-2009-skeletal-health-en | < 30 | 12 | llm | ✓ anchor_68ad95abff9 |
| shbat-2009-skeletal-health-en | DJD | 5 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Vikletice | 14 | llm | ✗ — |
| shbat-2009-skeletal-health-en | 112/63 | 1 | lexical | ✓ anchor_5b5491741da |
| shbat-2009-skeletal-health-en | Brandýsek | 10 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Humerus sin. distal part | 1 | lexical | ✓ anchor_98a68236942 |
| shbat-2009-skeletal-health-en | 69/56 | 1 | lexical | ✓ anchor_fc3dae43050 |
| shbat-2009-skeletal-health-en | 18/56 | 1 | lexical | ✓ anchor_0959a3999e3 |
| shbat-2009-skeletal-health-en | Ao 4820 | 1 | lexical | ✓ anchor_ccd97eb7c0d |
| shbat-2009-skeletal-health-en | Infection | 3 | llm | ✗ — |
| shbat-2009-skeletal-health-en | 16 - 24 | 1 | lexical | ✓ anchor_a3bb0863b1c |
| shbat-2009-skeletal-health-en | Left hip joint | 1 | lexical | ✓ anchor_21aa0666544 |
| shbat-2009-skeletal-health-en | F | 11 | llm | ✓ anchor_e0fc47a8a86 |
| shbat-2009-skeletal-health-en | Parietal bone | 7 | llm | ✓ anchor_6f545e600a5 |
| shbat-2009-skeletal-health-en | Trauma | 9 | llm | ✗ anchor_38a57645fae |
| shbat-2009-skeletal-health-en | Vikletice | 14 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Trauma | 9 | llm | ✗ — |
| shbat-2009-skeletal-health-en | F | 11 | llm | ✓ anchor_a5444f3f923 |
| shbat-2009-skeletal-health-en | M | 28 | llm | ✓ anchor_7f3fa8d9a56 |
| shbat-2009-skeletal-health-en | Trauma | 9 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Ao 5402 | 1 | lexical | ✓ anchor_3c903c23aef |
| shbat-2009-skeletal-health-en | Trauma | 9 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Distal part of right ulna and radius | 2 | llm | ✓ anchor_c5c5b6a84af |
| shbat-2009-skeletal-health-en | M | 28 | llm | ✓ anchor_dbf7eeec761 |
| shbat-2009-skeletal-health-en | 30 - 35 | 2 | llm | ✓ anchor_f0457e50fe2 |
| shbat-2009-skeletal-health-en | Cranium - left frontal bone | 2 | llm | ✓ anchor_2342c88adec |
| shbat-2009-skeletal-health-en | M | 28 | llm | ✓ anchor_dbf7eeec761 |
| shbat-2009-skeletal-health-en | Obj. 12/80 | 1 | lexical | ✓ anchor_05ff677ec3a |
| shbat-2009-skeletal-health-en | Ao 8606 | 2 | llm | ✓ anchor_1059f21d4f1 |
| shbat-2009-skeletal-health-en | Ao 8606 | 2 | llm | ✗ — |
| shbat-2009-skeletal-health-en | 20 - 24 | 1 | lexical | ✓ anchor_06afd175a7a |
| shbat-2009-skeletal-health-en | Penetrating longitudinal foramen with… | 1 | lexical | ✓ anchor_648a0b20ea3 |
| shbat-2009-skeletal-health-en | M | 28 | llm | ✓ anchor_2033633036c |
| shbat-2009-skeletal-health-en | Kněževes | 5 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Trauma | 9 | llm | ✗ — |
| shbat-2009-skeletal-health-en | Left frontal bone | 3 | llm | ✓ anchor_42ca904550a |
| shbat-2009-skeletal-health-en | 30 - 35 | 2 | llm | ✓ anchor_62010b1134f |
| shbat-2009-skeletal-health-en | 45+ | 19 | llm | ✓ anchor_2149db01669 |
| shbat-2009-skeletal-health-en | Os parietale sin. | 2 | llm | ✓ anchor_7e4106c2d30 |
