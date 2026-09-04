
## Policy E with qwen3.8:latest as the hit-set scorer

| set | claims | correct links | correct abstains | wrong links | protocol failures | model calls | avg ms/claim |
|---|---:|---:|---:|---:|---:|---:|---:|
| final_dataset_3 | 164 | 86/116 | 28/48 | 25 | 0 | 86 | 3809 |
| **pooled** | 164 | 86/116 | 28/48 | 25 | 0 | 86 | 3809 |

### Per-claim audit

| doc | claim | hits | tier | pick |
|---|---|---:|---|---|
| buchvaldek-1970-vikletice-tables-de | Schnurkeramische Gräber und Bestattungen | 1 | lexical | ✓ anchor_e2cb51723b3 |
| buchvaldek-1970-vikletice-tables-de | 182.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 36 | 21 | llm | ✓ anchor_68e04bd3ba7 |
| buchvaldek-1970-vikletice-tables-de | 151 | 3 | llm | ✓ anchor_92a2de57d02 |
| buchvaldek-1970-vikletice-tables-de | 83 | 8 | llm | ✓ anchor_462db51a761 |
| buchvaldek-1970-vikletice-tables-de | 146 | 11 | llm | ✓ anchor_14dd3c78eaa |
| buchvaldek-1970-vikletice-tables-de | 154 | 7 | llm | ✓ anchor_e41b263f611 |
| buchvaldek-1970-vikletice-tables-de | 364.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 19.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 380.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 275/64 | 2 | llm | ✓ anchor_4945dd85eb0 |
| buchvaldek-1970-vikletice-tables-de | 510.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 140.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 198.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 2150.0 | 0 | lexical | ✗ — |
| buchvaldek-1970-vikletice-tables-de | 76.6 | 1 | lexical | ✓ anchor_5201e0f35e3 |
| buchvaldek-1970-vikletice-tables-de | linker Hocker | 19 | llm | ✓ anchor_43e5c18ceb1 |
| buchvaldek-1970-vikletice-tables-de | 118.0 | 0 | lexical | ✓ — |
| buchvaldek-1970-vikletice-tables-de | 24 | 17 | llm | ✓ — |
| buchvaldek-1970-vikletice-tables-de | 2500.0 | 0 | lexical | ✓ — |
| buchvaldek-1970-vikletice-tables-de | 510.0 | 0 | lexical | ✓ — |
| buchvaldek-1970-vikletice-tables-de | 154 | 7 | llm | ✗ anchor_e41b263f611 |
| buchvaldek-1970-vikletice-tables-de | 83 | 8 | llm | ✗ anchor_462db51a761 |
| buchvaldek-1970-vikletice-tables-de | 13 | 72 | llm | ✗ anchor_e0eb389f0c7 |
| buchvaldek-1970-vikletice-tables-de | 75.0 | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | Interpretation des schnurkeramischen … | 1 | lexical | ✓ anchor_f6e188cdcff |
| buchvaldek-koutecky-1972-vikletice-de | Interpretace pohřebiště se šňůrovou k… | 1 | lexical | ✓ anchor_dad179524bd |
| buchvaldek-koutecky-1972-vikletice-de | Miroslav Buchvaldek | 1 | lexical | ✓ anchor_ca7aa6f0250 |
| buchvaldek-koutecky-1972-vikletice-de | Drahomír Koutecký | 1 | lexical | ✓ anchor_ca7aa6f0250 |
| buchvaldek-koutecky-1972-vikletice-de | 1972 | 1 | lexical | ✓ anchor_c1b22158549 |
| buchvaldek-koutecky-1972-vikletice-de | 1971-06-20 | 1 | lexical | ✓ anchor_f9baa3e4abb |
| buchvaldek-koutecky-1972-vikletice-de | Chomutov | 1 | lexical | ✓ anchor_6178f00c74c |
| buchvaldek-koutecky-1972-vikletice-de | 396 | 1 | lexical | ✓ anchor_1f08a744068 |
| buchvaldek-koutecky-1972-vikletice-de | 156 | 2 | llm | ✓ anchor_d92122a0885 |
| buchvaldek-koutecky-1972-vikletice-de | 145 | 7 | llm | ✓ anchor_335ee03bbfd |
| buchvaldek-koutecky-1972-vikletice-de | 66 | 9 | llm | ✓ anchor_335ee03bbfd |
| buchvaldek-koutecky-1972-vikletice-de | 10 | 52 | llm | ✓ anchor_fe1339fc3d7 |
| buchvaldek-koutecky-1972-vikletice-de | 160 | 11 | llm | ✓ anchor_6b7271a5ae9 |
| buchvaldek-koutecky-1972-vikletice-de | 158 | 4 | llm | ✓ anchor_c718d381273 |
| buchvaldek-koutecky-1972-vikletice-de | 2.19 | 1 | lexical | ✓ anchor_245e14f0e03 |
| buchvaldek-koutecky-1972-vikletice-de | 4.49 | 1 | lexical | ✓ anchor_1851848b2ab |
| buchvaldek-koutecky-1972-vikletice-de | 198 | 1 | lexical | ✓ anchor_856537dcd59 |
| buchvaldek-koutecky-1972-vikletice-de | Helena Plátková | 1 | lexical | ✓ anchor_e835970e472 |
| buchvaldek-koutecky-1972-vikletice-de | 70 | 7 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 0.16 | 0 | lexical | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 175 | 4 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 218 | 1 | lexical | ✗ anchor_07cbc83289f |
| buchvaldek-koutecky-1972-vikletice-de | 1970 | 6 | llm | ✗ anchor_7eb0831999b |
| buchvaldek-koutecky-1972-vikletice-de | 156 | 2 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 240 | 2 | llm | ✓ — |
| buchvaldek-koutecky-1972-vikletice-de | 1.32 | 1 | lexical | ✗ anchor_68ad976c850 |
| conrad-2011-bbc-graves-de | 2.34 | 2 | llm | ✓ anchor_1ff892bf024 |
| conrad-2011-bbc-graves-de | 0.8 | 10 | llm | ✓ anchor_055e5af5cb5 |
| conrad-2011-bbc-graves-de | 12 | 12 | llm | ✗ — |
| conrad-2011-bbc-graves-de | 1980 | 2 | llm | ✓ anchor_a3cfc0e9098 |
| conrad-2011-bbc-graves-de | m | 0 | lexical | ✗ — |
| conrad-2011-bbc-graves-de | Kölsa | 2 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | Grebehna | 2 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | Löbnitz-Bennewitz | 2 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | Markranstädt | 2 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | Zwenkau | 3 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | Großstorkwitz | 7 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | Wehlitz | 2 | llm | ✓ anchor_420bbc56fe1 |
| conrad-2011-bbc-graves-de | 0.1 | 6 | llm | ✓ anchor_ea29bb2e6e6 |
| conrad-2011-bbc-graves-de | 0.28 | 3 | llm | ✓ anchor_60521b191a7 |
| conrad-2011-bbc-graves-de | 0.49 | 1 | lexical | ✓ anchor_52f594c76bf |
| conrad-2011-bbc-graves-de | 0.36 | 1 | lexical | ✓ anchor_6380c15f55f |
| conrad-2011-bbc-graves-de | 48 | 8 | llm | ✗ — |
| conrad-2011-bbc-graves-de | weiblich | 17 | llm | ✗ anchor_05465db219c |
| conrad-2011-bbc-graves-de | 20 | 12 | llm | ✗ — |
| conrad-2011-bbc-graves-de | Leichenbrand | 4 | llm | ✗ — |
| conrad-2011-bbc-graves-de | 0.9 | 13 | llm | ✗ anchor_b718662585f |
| conrad-2011-bbc-graves-de | 12 | 12 | llm | ✗ — |
| conrad-2011-bbc-graves-de | S-N | 6 | llm | ✗ — |
| conrad-2011-bbc-graves-de | Marion Conrad | 0 | lexical | ✓ — |
| conrad-2011-bbc-graves-de | 0.25 | 3 | llm | ✗ anchor_0e2391a1170 |
| conrad-2011-bbc-graves-de | 0.35 | 4 | llm | ✗ anchor_f6c0856e1a3 |
| conrad-2011-bbc-graves-de | 0.84 | 5 | llm | ✗ anchor_e2ddcdaa1ee |
| conrad-2011-bbc-graves-de | 1958 | 16 | llm | ✗ anchor_a1a8a4ab4fb |
| conrad-2011-bbc-graves-de | 1901 | 1 | lexical | ✗ anchor_4ae6a0477f9 |
| conrad-2011-bbc-graves-de | 7 | 48 | llm | ✓ — |
| conrad-2011-bbc-graves-de | 711.3 | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | Gräber der Kugelamphorenkultur in Nor… | 1 | lexical | ✓ anchor_5226359f325 |
| dobes-1998-kugelamphoren-de | Miroslav Dobeš | 1 | lexical | ✓ anchor_de38a6dc293 |
| dobes-1998-kugelamphoren-de | Saarbrücker Studien und Materialien z… | 1 | lexical | ✓ anchor_55fba348da9 |
| dobes-1998-kugelamphoren-de | 1998 | 1 | lexical | ✓ anchor_29109e7378e |
| dobes-1998-kugelamphoren-de | 1936-02-09 | 1 | lexical | ✓ anchor_5df32c4fecf |
| dobes-1998-kugelamphoren-de | 34.0 | 1 | lexical | ✓ anchor_89c2157a04d |
| dobes-1998-kugelamphoren-de | 100.0 | 0 | lexical | ✗ — |
| dobes-1998-kugelamphoren-de | 14.8 | 2 | llm | ✓ anchor_68718e17ddf |
| dobes-1998-kugelamphoren-de | N-S | 1 | lexical | ✗ anchor_1e96da1d2be |
| dobes-1998-kugelamphoren-de | 22.6 | 1 | lexical | ✓ anchor_e0770d02051 |
| dobes-1998-kugelamphoren-de | 500.0 | 0 | lexical | ✗ — |
| dobes-1998-kugelamphoren-de | 175.0 | 0 | lexical | ✗ — |
| dobes-1998-kugelamphoren-de | 29.7 | 1 | lexical | ✓ anchor_93207a4d129 |
| dobes-1998-kugelamphoren-de | SW-NO | 3 | llm | ✓ anchor_055a0eb69bd |
| dobes-1998-kugelamphoren-de | 320.0 | 0 | lexical | ✗ — |
| dobes-1998-kugelamphoren-de | 1887 | 1 | lexical | ✓ anchor_16e656371ff |
| dobes-1998-kugelamphoren-de | 31 | 12 | llm | ✓ anchor_7b5f10749a2 |
| dobes-1998-kugelamphoren-de | 180.0 | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | 120.0 | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | 300.0 | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | 1988 | 23 | llm | ✗ anchor_b157162c301 |
| dobes-1998-kugelamphoren-de | 500.0 | 0 | lexical | ✓ — |
| dobes-1998-kugelamphoren-de | 27.0 | 1 | lexical | ✗ anchor_b32af41eb94 |
| dobes-1998-kugelamphoren-de | 8 | 45 | llm | ✗ anchor_422da46bd35 |
| dobes-1998-kugelamphoren-de | 30.0 | 0 | lexical | ✓ — |
| durankulak-catalogue-de | Katalog der prähistorischen Gräber vo… | 1 | lexical | ✓ anchor_e039c216ff8 |
| durankulak-catalogue-de | H. Todorova | 1 | lexical | ✓ anchor_e8dc34736a2 |
| durankulak-catalogue-de | T. Dimov | 1 | lexical | ✓ anchor_e8dc34736a2 |
| durankulak-catalogue-de | J. Bojadžiev | 1 | lexical | ✓ anchor_e8dc34736a2 |
| durankulak-catalogue-de | I. Vajsov | 1 | lexical | ✓ anchor_e8dc34736a2 |
| durankulak-catalogue-de | K. Dimitrov | 1 | lexical | ✓ anchor_e8dc34736a2 |
| durankulak-catalogue-de | M. Avramova | 1 | lexical | ✓ anchor_e8dc34736a2 |
| durankulak-catalogue-de | 0.95 | 36 | llm | ✓ anchor_b88a5a88f46 |
| durankulak-catalogue-de | 0.9 | 1 | lexical | ✗ anchor_785fa6d02b5 |
| durankulak-catalogue-de | Hamangia-Kultur | 759 | llm | ✗ — |
| durankulak-catalogue-de | Frau | 346 | llm | ✓ anchor_95f9ca60853 |
| durankulak-catalogue-de | Linker Hocker | 84 | llm | ✓ anchor_3b7d874b48d |
| durankulak-catalogue-de | 1.4 | 4 | llm | ✗ — |
| durankulak-catalogue-de | 0.95 | 36 | llm | ✓ anchor_e7b4b4f9da6 |
| durankulak-catalogue-de | 0.3 | 3 | llm | ✗ — |
| durankulak-catalogue-de | 30 | 174 | llm | ✗ — |
| durankulak-catalogue-de | 1.55 | 9 | llm | ✓ anchor_26a9edf1ecc |
| durankulak-catalogue-de | Mat. | 99 | llm | ✓ anchor_2b386a1e48e |
| durankulak-catalogue-de | 50 | 134 | llm | ✓ anchor_547528cb2c8 |
| durankulak-catalogue-de | True | 0 | lexical | ✗ — |
| durankulak-catalogue-de | NO | 70 | llm | ✓ anchor_958ea7040ac |
| durankulak-catalogue-de | 1.89 | 2 | llm | ✓ anchor_ccca416dcd0 |
| durankulak-catalogue-de | 0.55 | 34 | llm | ✓ — |
| durankulak-catalogue-de | 45 | 83 | llm | ✓ — |
| durankulak-catalogue-de | 2002 | 1 | lexical | ✗ anchor_e930075fa1f |
| durankulak-catalogue-de | 0.8 | 1 | lexical | ✗ anchor_d28b8d80507 |
| durankulak-catalogue-de | 1.4 | 4 | llm | ✓ — |
| durankulak-catalogue-de | 0.75 | 35 | llm | ✓ — |
| durankulak-catalogue-de | 6 | 270 | llm | ✓ — |
| durankulak-catalogue-de | 1204 | 1 | lexical | ✗ anchor_d8293107a23 |
| shbat-2009-skeletal-health-en | Skeletal health of late Neolithic pop… | 10 | llm | ✗ anchor_12a1c071fb6 |
| shbat-2009-skeletal-health-en | Andrej Shbat | 13 | llm | ✓ anchor_cf9fcbd81a5 |
| shbat-2009-skeletal-health-en | Ivana Růžičková | 12 | llm | ✓ anchor_cf9fcbd81a5 |
| shbat-2009-skeletal-health-en | Petra Herlová | 13 | llm | ✓ anchor_cf9fcbd81a5 |
| shbat-2009-skeletal-health-en | Anthropologie | 5 | llm | ✓ anchor_ecadf07673d |
| shbat-2009-skeletal-health-en | 2009 | 2 | llm | ✓ anchor_ecadf07673d |
| shbat-2009-skeletal-health-en | 195 | 0 | lexical | ✗ — |
| shbat-2009-skeletal-health-en | 257 | 4 | llm | ✓ anchor_295af45b4ab |
| shbat-2009-skeletal-health-en | 5 | 41 | llm | ✓ anchor_0ef2bac096e |
| shbat-2009-skeletal-health-en | 79.87 | 3 | llm | ✓ anchor_fbd5217f2a3 |
| shbat-2009-skeletal-health-en | 4.29 | 2 | llm | ✓ anchor_fbd5217f2a3 |
| shbat-2009-skeletal-health-en | 25.22 | 2 | llm | ✓ anchor_26d81d56783 |
| shbat-2009-skeletal-health-en | 167.83 | 1 | lexical | ✓ anchor_0922dad6593 |
| shbat-2009-skeletal-health-en | 61.82 | 1 | lexical | ✓ anchor_549c106b955 |
| shbat-2009-skeletal-health-en | 150 | 3 | llm | ✓ anchor_33abae9cb0f |
| shbat-2009-skeletal-health-en | 16 | 7 | llm | ✓ anchor_28fb876fded |
| shbat-2009-skeletal-health-en | Chomutov | 1 | lexical | ✓ anchor_0ef2bac096e |
| shbat-2009-skeletal-health-en | 36/63 | 1 | lexical | ✓ anchor_e652350c70b |
| shbat-2009-skeletal-health-en | 17 - 22 years | 1 | lexical | ✓ anchor_94198133bf4 |
| shbat-2009-skeletal-health-en | 35 - 45 | 0 | lexical | ✓ — |
| shbat-2009-skeletal-health-en | 215 | 0 | lexical | ✓ — |
| shbat-2009-skeletal-health-en | 15 | 10 | llm | ✓ — |
| shbat-2009-skeletal-health-en | Chomutov | 1 | lexical | ✗ anchor_0ef2bac096e |
| shbat-2009-skeletal-health-en | 1962 | 2 | llm | ✗ anchor_ecadf07673d |
| shbat-2009-skeletal-health-en | 147/63 | 1 | lexical | ✗ anchor_1b9e71d8191 |
| shbat-2009-skeletal-health-en | 20 | 12 | llm | ✓ — |
| shbat-2009-skeletal-health-en | 83.1 | 0 | lexical | ✓ — |
