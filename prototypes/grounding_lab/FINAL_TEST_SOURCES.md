# Final test set 1 sources (invalidated as a one-shot test)

Selected and checksummed on 2026-09-01 as a 100-claim test (20 per document,
25% absent/adversarial). It was replayed after a reporting change and its gold
labels were corrected after inference, so it is not an untouched test and
cannot support adoption; it is diagnostic and cross-validation data only.
`final_dataset_2/` (`FINAL_TEST_SOURCES_2.md`) replaced it for one completed
run, but that set is now also used and diagnostic only.

| dataset id | language / material | licence | source | SHA-256 |
|---|---|---|---|---|
| `eurostat-key-figures-2025-de` | German; narrative, charts, and tables | CC BY 4.0 / European Commission reuse | [Key figures on Europe, 2025 edition](https://ec.europa.eu/eurostat/documents/15216629/22447474/KS-01-25-003-DE-N.pdf/3eb63ead-4da9-c4c5-9e50-85015e7fa0fa?t=1761576538044&version=1.1) | `bb508bc33705ded32faedcef60800ea3bb3c1e4e33af823d94790ce30584612a` |
| `insee-bilan-demographique-2025-fr` | French; narrative and tables | Licence Ouverte 2.0 | [Bilan demographique 2025](https://www.insee.fr/fr/statistiques/fichier/8719824/ip2087.pdf) | `7d14255d10dc14faedc1de94e7b156fe6ea426beb30dd07f434f5a128658de13` |
| `istat-ambiente-2025-it` | Italian; infographic and tables | CC BY 4.0 | [Giornata mondiale dell'ambiente 2025](https://www.istat.it/wp-content/uploads/2025/06/Giornata-Ambiente-PDF-completo.pdf) | `985c1be06ab11a7e210b3f0b5a6a8557ce845990964e1b826962e236072af417` |
| `desnz-annual-report-2024-25-en` | English; narrative and financial tables | Open Government Licence v3.0 | [DESNZ annual report and accounts 2024-2025](https://assets.publishing.service.gov.uk/media/68cd6b2825860ae11bbea6fb/desnz-annual-report-and-accounts-2024-2025-web-optimised.pdf) | `72b5469849f25051b7facd2ab5be88a0b306ac6940ba37aa12f1ea5a39faa58a` |
| `us-census-income-2024-en` | English; narrative and statistical tables | US federal government work | [Income in the United States: 2024](https://www2.census.gov/library/publications/2025/demo/p60-286.pdf) | `54cf1adc1f92e0f471803e67637569ecdebf93eec21928a5f9e2b97185eed3d3` |

Local copies are in `final_sources/`, parsed with `scripts/parse-source.py`
under the Parsing Service's environment and anchored with `dump-anchors`.
Diagnostic results: `MODEL_REPORT.md`, policy screen, final set 1 column.
