
## LLM baseline (qwen3.8:27b, 5 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3.8:27b | 73/75 | 24/25 | 3 | 0 | 12128 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| espana-en-cifras-2025-es | 48.619.695 | ✓ anchor_20cd905eb1c |
| espana-en-cifras-2025-es | 13,28 | ✓ anchor_970b715926c |
| espana-en-cifras-2025-es | 320.656 | ✓ anchor_82dde24429a |
| espana-en-cifras-2025-es | 1,12 | ✓ anchor_bdce4b10f37 |
| espana-en-cifras-2025-es | 436.124 | ✓ anchor_14e401a7ce6 |
| espana-en-cifras-2025-es | 83,77 años | ✗ anchor_3c9996f19b3 |
| espana-en-cifras-2025-es | 172.430 | ✓ anchor_d9e53184677 |
| espana-en-cifras-2025-es | 22.880 millones de euros | ✓ anchor_e2fd7ed7f24 |
| espana-en-cifras-2025-es | 128 litros | ✗ anchor_3dd156487db |
| espana-en-cifras-2025-es | 25.107 millones de euros | ✓ anchor_a51e42c7364 |
| espana-en-cifras-2025-es | 13,4% | ✓ anchor_fc59cfe9559 |
| espana-en-cifras-2025-es | 505.983 | ✓ anchor_980945c8425 |
| espana-en-cifras-2025-es | 83.445,0 | ✓ anchor_e03992d2afb |
| espana-en-cifras-2025-es | 5,07 | ✓ anchor_ecb5227d3bf |
| espana-en-cifras-2025-es | 52,0% | ✓ anchor_704ab7f5c3d |
| espana-en-cifras-2025-es | 48.619.696 | ✓ — |
| espana-en-cifras-2025-es | 320.657 | ✓ — |
| espana-en-cifras-2025-es | 83,78 años | ✓ — |
| espana-en-cifras-2025-es | 172.431 | ✓ — |
| espana-en-cifras-2025-es | 6,6 millones | ✓ — |
| fed-monetary-policy-report-2025-06-en | 2.1 percent | ✓ anchor_637278e70bc |
| fed-monetary-policy-report-2025-06-en | 2.5 percent | ✓ anchor_637278e70bc |
| fed-monetary-policy-report-2025-06-en | 4.2 percent in May | ✓ anchor_56eff06af46 |
| fed-monetary-policy-report-2025-06-en | 3.3 percent | ✓ anchor_5ae2c980a29 |
| fed-monetary-policy-report-2025-06-en | $180 billion | ✓ anchor_7a2e08d89cd |
| fed-monetary-policy-report-2025-06-en | more than $2 trillion | ✓ anchor_7a2e08d89cd |
| fed-monetary-policy-report-2025-06-en | 4¼ to 4½ percent | ✓ anchor_bce0ae564ed |
| fed-monetary-policy-report-2025-06-en | 4,212 | ✓ anchor_20bfd7ef67c |
| fed-monetary-policy-report-2025-06-en | 6,677 | ✓ anchor_606b44c0b0c |
| fed-monetary-policy-report-2025-06-en | -344 | ✓ anchor_efea88b1631 |
| fed-monetary-policy-report-2025-06-en | 4.4 | ✓ anchor_d35f71741c9 |
| fed-monetary-policy-report-2025-06-en | 3.9 | ✓ anchor_37e5d712fdb |
| fed-monetary-policy-report-2025-06-en | 1.4 | ✓ anchor_173d245909c |
| fed-monetary-policy-report-2025-06-en | June 18, 2025 | ✓ anchor_3926618b2e0 |
| fed-monetary-policy-report-2025-06-en | January 30, 2024 | ✓ anchor_68a456a72e5 |
| fed-monetary-policy-report-2025-06-en | $190 billion | ✓ — |
| fed-monetary-policy-report-2025-06-en | 4.3 percent in May | ✓ — |
| fed-monetary-policy-report-2025-06-en | 6,678 | ✓ — |
| fed-monetary-policy-report-2025-06-en | 2.4 percent | ✗ anchor_336c6bd420c |
| fed-monetary-policy-report-2025-06-en | more than $3 trillion | ✓ — |
| nederland-in-cijfers-2024-nl | 1899 | ✓ anchor_416ad7ecff1 |
| nederland-in-cijfers-2024-nl | 1924 | ✓ anchor_416ad7ecff1 |
| nederland-in-cijfers-2024-nl | 34 infographics | ✓ anchor_220eea93b84 |
| nederland-in-cijfers-2024-nl | 4,4 maaltijden met vlees | ✓ anchor_aff8cf361b1 |
| nederland-in-cijfers-2024-nl | 1,8 vegetarische maaltijden | ✓ anchor_686118807f2 |
| nederland-in-cijfers-2024-nl | 1 319 000 | ✓ anchor_1021140697a |
| nederland-in-cijfers-2024-nl | 244 000 | ✓ anchor_6f885332ac0 |
| nederland-in-cijfers-2024-nl | € 3,2 miljard | ✓ anchor_b5410e69c0a |
| nederland-in-cijfers-2024-nl | € 10,7 miljard | ✓ anchor_292438384c9 |
| nederland-in-cijfers-2024-nl | € 0,1 miljard | ✓ anchor_a68bb1d9c7d |
| nederland-in-cijfers-2024-nl | 228,1 | ✓ anchor_935b25df7cc |
| nederland-in-cijfers-2024-nl | 149,5 | ✓ anchor_2ae6bf07adf |
| nederland-in-cijfers-2024-nl | 19 040 | ✓ anchor_5b925d0d960 |
| nederland-in-cijfers-2024-nl | 229 000 | ✓ anchor_5c7651fc969 |
| nederland-in-cijfers-2024-nl | 12% | ✓ anchor_b2d649fa5f7 |
| nederland-in-cijfers-2024-nl | 1898 | ✓ — |
| nederland-in-cijfers-2024-nl | 1925 | ✓ — |
| nederland-in-cijfers-2024-nl | 35 infographics | ✓ — |
| nederland-in-cijfers-2024-nl | € 3,3 miljard | ✓ — |
| nederland-in-cijfers-2024-nl | 19 041 | ✓ — |
| polska-w-liczbach-2025-pl | 37 489 | ✓ anchor_030a75afb98 |
| polska-w-liczbach-2025-pl | 2 477 | ✓ anchor_322c36307c6 |
| polska-w-liczbach-2025-pl | 1 864 | ✓ anchor_f249bff7c1c |
| polska-w-liczbach-2025-pl | 43,3 | ✓ anchor_baf71d43fee |
| polska-w-liczbach-2025-pl | 6,7 | ✓ anchor_e087c2d7241 |
| polska-w-liczbach-2025-pl | -4,2 | ✓ anchor_cb961eac2c9 |
| polska-w-liczbach-2025-pl | 8 181,72 | ✓ anchor_6e1fe4749e8 |
| polska-w-liczbach-2025-pl | 2,9 | ✓ anchor_3cd8879f77f |
| polska-w-liczbach-2025-pl | 1 512,2 | ✓ anchor_c23c5f9c882 |
| polska-w-liczbach-2025-pl | 3 167,17 | ✓ anchor_f8aa8570f4e |
| polska-w-liczbach-2025-pl | 2,41 | ✓ anchor_4fffbc2840f |
| polska-w-liczbach-2025-pl | 102,9 | ✓ anchor_311af3b4be2 |
| polska-w-liczbach-2025-pl | 1 491 700 | ✓ anchor_c29c7bd30a4 |
| polska-w-liczbach-2025-pl | 119 | ✓ anchor_737cf5da2f4 |
| polska-w-liczbach-2025-pl | 2 499 | ✓ anchor_04686d7168b |
| polska-w-liczbach-2025-pl | 37 490 | ✓ — |
| polska-w-liczbach-2025-pl | 2 478 | ✓ — |
| polska-w-liczbach-2025-pl | 8 181,73 | ✓ — |
| polska-w-liczbach-2025-pl | 1 512,3 | ✓ — |
| polska-w-liczbach-2025-pl | 3 167,18 | ✓ — |
| suomi-lukuina-2025-fi | 5 635 971 | ✓ anchor_8ae75212d1d |
| suomi-lukuina-2025-fi | 2 790 772 | ✓ anchor_14650f3772d |
| suomi-lukuina-2025-fi | 338 491 | ✓ anchor_1fa57ac1cdd |
| suomi-lukuina-2025-fi | 1 324 | ✓ anchor_9e804d334d9 |
| suomi-lukuina-2025-fi | 1 393 | ✓ anchor_e25809e35cf |
| suomi-lukuina-2025-fi | 1 082 | ✓ anchor_c77b10a4e4c |
| suomi-lukuina-2025-fi | 43 720 | ✓ anchor_98b108b2b8f |
| suomi-lukuina-2025-fi | 58 267 | ✓ anchor_aae5183f85d |
| suomi-lukuina-2025-fi | 47 051 | ✓ anchor_3cfdb61f073 |
| suomi-lukuina-2025-fi | 21 420 | ✓ anchor_a94166c0686 |
| suomi-lukuina-2025-fi | 610 148 | ✓ anchor_a602a372512 |
| suomi-lukuina-2025-fi | 41 403 | ✓ anchor_bdbc9634b66 |
| suomi-lukuina-2025-fi | 1 782 300 | ✓ anchor_858a164e6f0 |
| suomi-lukuina-2025-fi | 84,1 | ✓ anchor_688fc99c236 |
| suomi-lukuina-2025-fi | 238 | ✓ anchor_56ab893a1e6 |
| suomi-lukuina-2025-fi | 5 635 972 | ✓ — |
| suomi-lukuina-2025-fi | 43 721 | ✓ — |
| suomi-lukuina-2025-fi | 47 052 | ✓ — |
| suomi-lukuina-2025-fi | 1 782 301 | ✓ — |
| suomi-lukuina-2025-fi | 58 268 | ✓ — |
