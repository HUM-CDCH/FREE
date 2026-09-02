# Final dataset source provenance

Both sets were replayed and relabeled, so they are burned diagnostic
cross-validation data and cannot support adoption. Local copies are in
`final_sources/` and `final_sources_2/`, parsed with `scripts/parse-source.py`
under the Parsing Service's environment and anchored with `dump-anchors`.
Results are in `MODEL_REPORT.md`.

## `final_dataset` (selected 2026-09-01)

| dataset id | language / material | licence | source | SHA-256 |
|---|---|---|---|---|
| `eurostat-key-figures-2025-de` | German; narrative, charts, and tables | CC BY 4.0 / European Commission reuse | [Key figures on Europe, 2025 edition](https://ec.europa.eu/eurostat/documents/15216629/22447474/KS-01-25-003-DE-N.pdf/3eb63ead-4da9-c4c5-9e50-85015e7fa0fa?t=1761576538044&version=1.1) | `bb508bc33705ded32faedcef60800ea3bb3c1e4e33af823d94790ce30584612a` |
| `insee-bilan-demographique-2025-fr` | French; narrative and tables | Licence Ouverte 2.0 | [Bilan demographique 2025](https://www.insee.fr/fr/statistiques/fichier/8719824/ip2087.pdf) | `7d14255d10dc14faedc1de94e7b156fe6ea426beb30dd07f434f5a128658de13` |
| `istat-ambiente-2025-it` | Italian; infographic and tables | CC BY 4.0 | [Giornata mondiale dell'ambiente 2025](https://www.istat.it/wp-content/uploads/2025/06/Giornata-Ambiente-PDF-completo.pdf) | `985c1be06ab11a7e210b3f0b5a6a8557ce845990964e1b826962e236072af417` |
| `desnz-annual-report-2024-25-en` | English; narrative and financial tables | Open Government Licence v3.0 | [DESNZ annual report and accounts 2024-2025](https://assets.publishing.service.gov.uk/media/68cd6b2825860ae11bbea6fb/desnz-annual-report-and-accounts-2024-2025-web-optimised.pdf) | `72b5469849f25051b7facd2ab5be88a0b306ac6940ba37aa12f1ea5a39faa58a` |
| `us-census-income-2024-en` | English; narrative and statistical tables | US federal government work | [Income in the United States: 2024](https://www2.census.gov/library/publications/2025/demo/p60-286.pdf) | `54cf1adc1f92e0f471803e67637569ecdebf93eec21928a5f9e2b97185eed3d3` |

## `final_dataset_2` (selected 2026-09-02)

None overlaps with `dataset/` or `final_dataset/`.

| dataset id | language / material | licence | source | pages | SHA-256 |
|---|---|---|---|---:|---|
| `espana-en-cifras-2025-es` | Spanish; narrative, charts, tables | CC BY 4.0 (INE aviso legal) | [España en cifras 2025](https://ine.es/prodyser/espa_cifras/EEC_2025_PUBLICACION_COMPLETA.pdf) | 60 | `5ef7a40059644ceaae9b26033952eb28128d48ada5a2c47114329951f5134f62` |
| `nederland-in-cijfers-2024-nl` | Dutch; short narrative, tables, infographics | CC BY 4.0 (CBS) | [Nederland in cijfers 2024](https://www.cbs.nl/-/media/_pdf/2024/36/nederland-in-cijfers_2024.pdf) | 45 | `b962ae7f3ea1711bc65764b3e272db20f28140e6946593a65da33742661e4d93` |
| `polska-w-liczbach-2025-pl` | Polish; tables and infographics | GUS: free reuse with attribution | [Polska w liczbach 2025](https://stat.gov.pl/files/gfx/portalinformacyjny/pl/defaultaktualnosci/5501/14/18/1/polska_w_liczbach_2025_v2.pdf) | 42 | `bfc5ceafc4ec4d3b5109f918ca3604fc019d4bd88f0e35ac91159f98b34c1d96` |
| `suomi-lukuina-2025-fi` | Finnish; tables with short narrative | CC BY 4.0 (Tilastokeskus, ISBN 978-952-244-733-3) | [Suomi lukuina 2025](https://otos.stat.fi/server/api/core/bitstreams/84f2a2b6-0c82-46e5-b056-dd8512575f5e/content) | 44 | `1ca76832ea19049cef2ecb99b52f26d013a55f4f19950b4bf2077b04b3b53e51` |
| `fed-monetary-policy-report-2025-06-en` | English; narrative, charts, tables | US federal government work (public domain) | [Monetary Policy Report, June 2025](https://www.federalreserve.gov/monetarypolicy/files/20250620_mprfullreport.pdf) | 81 | `6f8538cb4ce2902ac35cc9ec8311feda6c5c94953b76db50de94192741bb07f4` |
