# Full-repository cluster review candidates

Clusters marked `unreviewed` are not counted as false positives in the controlled metrics.
Add decisions to `adjudications.json` and rerun the report to include them.

## dfd7778ecca0b87f — adjudicated_positive

qwen3-0.6b-512d #1 (1.1328), qwen3-0.6b-1024d #1 (1.1328), pplx-v1-0.6b-512d #1 (1.1328), voyage-4-nano-256d #1 (1.1328), voyage-4-nano-512d #1 (1.1328), jina-v2-code-768d #2 (1.1328), pplx-v1-0.6b-1024d #2 (1.1328)

- `prototypes/studio/api/_project_operations.ts::<unknown>` lines 54-56
- `packages/extraction/src/batch-worker.ts::<unknown>` lines 37-37

## 0c6541d5f8ec3089 — adjudicated_negative

pplx-v1-0.6b-1024d #1 (1.1328), pplx-v1-0.6b-512d #2 (1.1328)

- `prototypes/studio/api/_model_output.ts::isRecord` lines 141-143
- `packages/extraction/src/allowed-values.ts::isRecord` lines 98-100
- `prototypes/studio/shared/template.ts::isRecord` lines 2-4
- `packages/extraction/src/schema.ts::isRecord` lines 257-259
- `packages/extraction-result-export/src/table.ts::isObject` lines 40-42
- `__benchmark__/typescript/type3.ts::hasRecordShape` lines 1-4
- `prototypes/studio/api/source_documents.ts::record` lines 133-137
- `prototypes/studio/api/_provider.ts::record` lines 274-277

## eeca9db029646e9c — adjudicated_negative

jina-v2-code-768d #1 (1.1328)

- `prototypes/studio/shared/template.ts::isRecord` lines 2-4
- `packages/extraction/src/allowed-values.ts::isRecord` lines 98-100
- `prototypes/studio/api/_model_output.ts::isRecord` lines 141-143
- `packages/extraction/src/schema.ts::isRecord` lines 257-259
- `__benchmark__/typescript/type3.ts::hasRecordShape` lines 1-4
- `packages/extraction-result-export/src/table.ts::isObject` lines 40-42
- `__benchmark__/typescript/hard_negatives.ts::isObjectLike` lines 1-3
- `__benchmark__/typescript/type2.ts::isPlainRecord` lines 1-3

## c794222336a798ce — adjudicated_positive

qwen3-0.6b-512d #2 (1.1328), qwen3-0.6b-1024d #2 (1.1328)

- `prototypes/studio/shared/template.ts::isRecord` lines 2-4
- `packages/extraction/src/allowed-values.ts::isRecord` lines 98-100
- `prototypes/studio/api/_model_output.ts::isRecord` lines 141-143
- `packages/extraction/src/schema.ts::isRecord` lines 257-259
- `packages/extraction-result-export/src/table.ts::isObject` lines 40-42
- `__benchmark__/typescript/type3.ts::hasRecordShape` lines 1-4

## 769500431302ce95 — adjudicated_negative

voyage-4-nano-256d #2 (1.1328), voyage-4-nano-512d #2 (1.1328)

- `prototypes/studio/api/_model_output.ts::isRecord` lines 141-143
- `packages/extraction/src/allowed-values.ts::isRecord` lines 98-100
- `prototypes/studio/shared/template.ts::isRecord` lines 2-4
- `packages/extraction/src/schema.ts::isRecord` lines 257-259
- `packages/extraction-result-export/src/table.ts::isObject` lines 40-42
- `__benchmark__/typescript/hard_negatives.ts::isObjectLike` lines 1-3
- `__benchmark__/typescript/type3.ts::hasRecordShape` lines 1-4

## 58f14ea07bcb256c — adjudicated_positive

qwen3-0.6b-512d #3 (1.1223), qwen3-0.6b-1024d #3 (1.1223), jina-v2-code-768d #4 (1.1223), pplx-v1-0.6b-512d #4 (1.1223), pplx-v1-0.6b-1024d #4 (1.1223), voyage-4-nano-256d #4 (1.1223), voyage-4-nano-512d #5 (1.1223)

- `prototypes/parsing_service_simple/app/docling_parser.py::_normalise_lf` lines 927-928
- `prototypes/parsing_service/app/parsing/v2_publication.py::_normalise_lf` lines 57-58

## ec251bb23828ca21 — adjudicated_positive

voyage-4-nano-256d #3 (1.1278), voyage-4-nano-512d #3 (1.1282), qwen3-0.6b-512d #5 (1.1216), qwen3-0.6b-1024d #5 (1.1200), pplx-v1-0.6b-512d #20 (1.0635), pplx-v1-0.6b-1024d #20 (1.0647)

- `prototypes/studio/api/_project_operations.ts::<unknown>` lines 50-61
- `packages/extraction/src/batch-worker.ts::<unknown>` lines 33-40

## 2d7f76662b4a2b5e — adjudicated_positive

pplx-v1-0.6b-512d #3 (1.1223), pplx-v1-0.6b-1024d #3 (1.1223), qwen3-0.6b-512d #4 (1.1223), qwen3-0.6b-1024d #4 (1.1223)

- `prototypes/parsing_service_simple/app/storage.py::_json_bytes` lines 58-71
- `prototypes/parsing_service/app/storage/canonical_package.py::_json_bytes` lines 131-144

## 52da2d5c9a6dfdac — adjudicated_negative

jina-v2-code-768d #3 (1.1223)

- `prototypes/parsing_service_simple/app/storage.py::_json_bytes` lines 58-71
- `prototypes/parsing_service/app/storage/canonical_package.py::_json_bytes` lines 131-144
- `__benchmark__/python/hard_negatives.py::encode_compact_json` lines 7-15

## e23ec9903849f663 — adjudicated_positive

voyage-4-nano-512d #4 (1.1223), voyage-4-nano-256d #5 (1.1223)

- `prototypes/parsing_service_simple/app/storage.py::_json_bytes` lines 58-71
- `prototypes/parsing_service/app/storage/canonical_package.py::_json_bytes` lines 131-144
- `__benchmark__/python/type2.py::serialize_json_payload` lines 7-20

## e02d92070a565d2d — adjudicated_positive

jina-v2-code-768d #5 (1.1185), pplx-v1-0.6b-512d #5 (1.1175), pplx-v1-0.6b-1024d #5 (1.1176), qwen3-0.6b-512d #6 (1.1190), qwen3-0.6b-1024d #6 (1.1189), voyage-4-nano-256d #7 (1.1172), voyage-4-nano-512d #7 (1.1166)

- `prototypes/parsing_service_simple/app/storage.py::_zip_info` lines 131-142
- `prototypes/parsing_service/app/storage/canonical_package.py::_zip_info` lines 208-219

## d882da1cb6f70817 — adjudicated_positive

jina-v2-code-768d #6 (1.1162), qwen3-0.6b-512d #8 (1.1146), qwen3-0.6b-1024d #8 (1.1157), voyage-4-nano-256d #9 (1.1105), voyage-4-nano-512d #9 (1.1111), pplx-v1-0.6b-512d #12 (1.0960), pplx-v1-0.6b-1024d #13 (1.0930)

- `prototypes/parsing_service_simple/app/main.py::__init__` lines 42-44
- `prototypes/parsing_service/app/api/request_admission.py::__init__` lines 15-21

## 44a2b06fabb5c141 — adjudicated_positive

pplx-v1-0.6b-512d #6 (1.1099), pplx-v1-0.6b-1024d #8 (1.1099), jina-v2-code-768d #9 (1.1099), qwen3-0.6b-1024d #10 (1.1099), voyage-4-nano-256d #11 (1.1099), voyage-4-nano-512d #12 (1.1099), qwen3-0.6b-512d #13 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::stableJson` lines 69-78
- `packages/db/src/project-store.ts::stableJson` lines 332-341

## be5bd509035362ec — adjudicated_positive

voyage-4-nano-256d #6 (1.1193), voyage-4-nano-512d #6 (1.1195), pplx-v1-0.6b-512d #15 (1.0779), pplx-v1-0.6b-1024d #15 (1.0806), qwen3-0.6b-512d #22 (1.0893), qwen3-0.6b-1024d #22 (1.0856)

- `prototypes/parsing_service_simple/app/storage.py::_sha256` lines 54-55
- `prototypes/parsing_service/app/storage/canonical_package.py::_sha256_bytes` lines 72-73

## a28c03c4d6a02e6f — adjudicated_positive

pplx-v1-0.6b-1024d #6 (1.1099), pplx-v1-0.6b-512d #9 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 928-932
- `packages/db/src/project-store.ts::<unknown>` lines 144-148

## 7cea32c85722e150 — adjudicated_positive

jina-v2-code-768d #7 (1.1135), qwen3-0.6b-512d #7 (1.1181), qwen3-0.6b-1024d #7 (1.1176), voyage-4-nano-256d #8 (1.1137), voyage-4-nano-512d #8 (1.1133), pplx-v1-0.6b-512d #11 (1.1028), pplx-v1-0.6b-1024d #11 (1.1025)

- `prototypes/parsing_service_simple/app/main.py::_require_completed` lines 82-89
- `prototypes/parsing_service/app/api/deps.py::require_completed` lines 49-54

## f64485e104f03cc9 — adjudicated_positive

pplx-v1-0.6b-512d #7 (1.1099), pplx-v1-0.6b-1024d #9 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 859-863
- `packages/db/src/project-store.ts::<unknown>` lines 132-136
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 916-920

## 291815726be96508 — adjudicated_negative

pplx-v1-0.6b-1024d #7 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 378-382
- `packages/db/src/project-store.ts::<unknown>` lines 138-142
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 865-869
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 351-355
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 922-926
- `packages/db/src/project-store.ts::<unknown>` lines 95-99
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 871-875
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 406-410
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1582-1586
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1501-1505
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1527-1531
- `packages/db/src/project-store.ts::<unknown>` lines 89-93
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 877-881
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1509-1513
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1515-1525

## c326a56299069cc9 — adjudicated_positive

jina-v2-code-768d #8 (1.1107)

- `prototypes/studio/api/_project_operations.ts::<unknown>` lines 50-61
- `packages/extraction/src/batch-worker.ts::<unknown>` lines 33-40
- `prototypes/studio/api/_project_operations.ts::leaseSignal` lines 44-67
- `packages/extraction/src/batch-worker.ts::leaseGuard` lines 26-48

## e8106c30ba2292f8 — adjudicated_negative

pplx-v1-0.6b-512d #8 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 351-355
- `packages/db/src/project-store.ts::<unknown>` lines 138-142
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 922-926
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 378-382
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 865-869
- `packages/db/src/project-store.ts::<unknown>` lines 95-99
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 871-875
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 406-410
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1582-1586
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1501-1505
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1527-1531
- `packages/db/src/project-store.ts::<unknown>` lines 89-93
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 877-881
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 358-365
- `packages/db/src/project-store.ts::<unknown>` lines 109-117
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 894-905
- `packages/db/src/project-store.ts::<unknown>` lines 149-160
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 933-943
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 385-392
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 413-424
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1509-1513
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1515-1525

## 2fe2d53541929572 — adjudicated_positive

qwen3-0.6b-512d #9 (1.1123), qwen3-0.6b-1024d #9 (1.1112), jina-v2-code-768d #18 (1.0892), pplx-v1-0.6b-1024d #18 (1.0693), pplx-v1-0.6b-512d #19 (1.0699), voyage-4-nano-256d #27 (1.0616), voyage-4-nano-512d #27 (1.0540)

- `prototypes/parsing_service_simple/app/main.py::get_task_pdf` lines 253-258
- `prototypes/parsing_service/app/api/routes_documents.py::get_task_pdf` lines 57-70

## beb507b4abe65256 — adjudicated_positive

qwen3-0.6b-512d #10 (1.1099), pplx-v1-0.6b-512d #10 (1.1099), pplx-v1-0.6b-1024d #10 (1.1099), voyage-4-nano-512d #10 (1.1099), jina-v2-code-768d #11 (1.1099), qwen3-0.6b-1024d #13 (1.1099), voyage-4-nano-256d #13 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 74-74
- `packages/db/src/project-store.ts::<unknown>` lines 337-337

## 6992be3ec9abf997 — adjudicated_negative

voyage-4-nano-256d #10 (1.1099), voyage-4-nano-512d #11 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 378-382
- `packages/db/src/project-store.ts::<unknown>` lines 138-142
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 865-869
- `packages/db/src/project-store.ts::<unknown>` lines 95-99
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 871-875
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 351-355
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 922-926
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 406-410
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1501-1505
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1582-1586
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1527-1531
- `packages/db/src/project-store.ts::<unknown>` lines 89-93
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 877-881
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 358-365
- `packages/db/src/project-store.ts::<unknown>` lines 149-160
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 933-943
- `packages/db/src/project-store.ts::<unknown>` lines 109-117
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 894-905
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 385-392
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1515-1525
- `packages/db/src/project-store.ts::<unknown>` lines 132-136
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 859-863
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 345-349
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 916-920
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1509-1513
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 413-424

## 980e4d9e8736cb90 — adjudicated_negative

jina-v2-code-768d #10 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 351-355
- `packages/db/src/project-store.ts::<unknown>` lines 138-142
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 922-926
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 378-382
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 865-869
- `packages/db/src/project-store.ts::<unknown>` lines 95-99
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 871-875
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 345-349
- `packages/db/src/project-store.ts::<unknown>` lines 132-136
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 859-863
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 916-920
- `packages/db/src/project-store.ts::<unknown>` lines 149-160
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 894-905
- `packages/db/src/project-store.ts::<unknown>` lines 109-117
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 385-392
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1515-1525
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 413-424
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1544-1571
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1589-1608
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 358-365
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 933-943
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1509-1513
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1527-1531
- `packages/db/src/project-store.ts::<unknown>` lines 89-93
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 877-881
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 406-410
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1582-1586
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1501-1505

## 4acb9019163cae83 — adjudicated_negative

qwen3-0.6b-512d #11 (1.1099), voyage-4-nano-256d #12 (1.1099), voyage-4-nano-512d #13 (1.1099), qwen3-0.6b-1024d #14 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 928-932
- `packages/db/src/project-store.ts::<unknown>` lines 144-148
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 883-893
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1533-1543

## d7250debca36e41d — adjudicated_negative

qwen3-0.6b-1024d #11 (1.1099), qwen3-0.6b-512d #12 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 378-382
- `packages/db/src/project-store.ts::<unknown>` lines 138-142
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 865-869
- `packages/db/src/project-store.ts::<unknown>` lines 95-99
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 406-410
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 922-926
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 351-355
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 871-875

## 2a28ae330973a349 — adjudicated_positive

pplx-v1-0.6b-1024d #12 (1.0961), jina-v2-code-768d #13 (1.1074), pplx-v1-0.6b-512d #13 (1.0958), voyage-4-nano-256d #14 (1.1054), qwen3-0.6b-512d #15 (1.1080), qwen3-0.6b-1024d #15 (1.1081), voyage-4-nano-512d #16 (1.1056)

- `packages/extraction/src/postgres-persistence.ts::uniqueConstraint` lines 63-65
- `packages/db/src/project-store.ts::uniqueConstraint` lines 165-172

## 1d213e6b622fad1f — adjudicated_negative

jina-v2-code-768d #12 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 928-932
- `packages/db/src/project-store.ts::<unknown>` lines 144-148
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 883-893
- `packages/db/src/project-store.ts::<unknown>` lines 101-108
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1533-1543

## 2a6cd6ea0c1b4da9 — adjudicated_negative

qwen3-0.6b-1024d #12 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 859-863
- `packages/db/src/project-store.ts::<unknown>` lines 132-136
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 916-920
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1509-1513
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1515-1525
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 345-349
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 877-881
- `packages/db/src/project-store.ts::<unknown>` lines 89-93
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1527-1531

## acc8cb1452cc1bff — adjudicated_positive

jina-v2-code-768d #14 (1.1028), qwen3-0.6b-512d #17 (1.1030), qwen3-0.6b-1024d #17 (1.1023), pplx-v1-0.6b-512d #21 (1.0563), pplx-v1-0.6b-1024d #22 (1.0539), voyage-4-nano-256d #25 (1.0674), voyage-4-nano-512d #25 (1.0657)

- `prototypes/parsing_service_simple/app/storage.py::utc_now` lines 48-51
- `prototypes/parsing_service/app/timing.py::utc_now` lines 5-6
- `prototypes/parsing_service_simple/app/docling_parser.py::_utc_now` lines 884-885

## 2fcd60ab828b5d6c — adjudicated_positive

pplx-v1-0.6b-512d #14 (1.0870), pplx-v1-0.6b-1024d #14 (1.0864), jina-v2-code-768d #15 (1.0974), qwen3-0.6b-1024d #19 (1.0958), qwen3-0.6b-512d #20 (1.0980)

- `packages/extraction/src/postgres-persistence.ts::stableUuid` lines 79-83
- `packages/db/src/project-store.ts::stableUuid` lines 343-348

## 76eea503dabe8367 — adjudicated_positive

voyage-4-nano-512d #14 (1.1065), voyage-4-nano-256d #15 (1.1045), qwen3-0.6b-512d #30 (1.0733), qwen3-0.6b-1024d #30 (1.0643)

- `prototypes/studio/api/_project_operations.ts::leaseSignal` lines 44-67
- `packages/extraction/src/batch-worker.ts::leaseGuard` lines 26-48

## 442cfebcffd62cab — adjudicated_negative

qwen3-0.6b-512d #14 (1.1099)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 859-863
- `packages/db/src/project-store.ts::<unknown>` lines 132-136
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 916-920
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1509-1513
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1515-1525
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 345-349

## d4405c07faea391e — adjudicated_positive

voyage-4-nano-512d #15 (1.1065), voyage-4-nano-256d #16 (1.1015)

- `prototypes/studio/api/batch_extractions.ts::batchDto` lines 31-63
- `packages/extraction/src/postgres-persistence.ts::snapshot` lines 123-147

## e4afa4171f6863f6 — adjudicated_positive

pplx-v1-0.6b-512d #16 (1.0745), jina-v2-code-768d #17 (1.0933), pplx-v1-0.6b-1024d #17 (1.0715), qwen3-0.6b-1024d #21 (1.0864), qwen3-0.6b-512d #23 (1.0868), voyage-4-nano-256d #26 (1.0653), voyage-4-nano-512d #26 (1.0612)

- `prototypes/parsing_service_simple/app/docling_parser.py::append` lines 390-396
- `prototypes/parsing_service/app/parsing/v2_publication.py::append` lines 193-198

## e60691b0fd74c636 — adjudicated_positive

qwen3-0.6b-512d #16 (1.1073), qwen3-0.6b-1024d #16 (1.1074), jina-v2-code-768d #20 (1.0816), voyage-4-nano-512d #23 (1.0725), voyage-4-nano-256d #24 (1.0729), pplx-v1-0.6b-1024d #34 (1.0190), pplx-v1-0.6b-512d #35 (1.0169)

- `prototypes/parsing_service_simple/app/docling_parser.py::_cell_role` lines 1009-1016
- `prototypes/parsing_service/app/parsing/docling_inventory.py::_cell_role` lines 75-82

## 2ee6b9a7df7ecd52 — adjudicated_positive

pplx-v1-0.6b-1024d #16 (1.0732), pplx-v1-0.6b-512d #17 (1.0732), jina-v2-code-768d #21 (1.0732), voyage-4-nano-512d #22 (1.0732), voyage-4-nano-256d #23 (1.0732), qwen3-0.6b-1024d #28 (1.0732), qwen3-0.6b-512d #31 (1.0732)

- `packages/extraction/src/postgres-persistence.ts::isExtractionIdAvailable` lines 534-540
- `packages/extraction/src/postgres-persistence.ts::isExtractionIdAvailable` lines 1683-1689
- `packages/extraction/src/postgres-persistence.ts::isExtractionIdAvailable` lines 1004-1010

## 1350784935a9c3f0 — adjudicated_positive

jina-v2-code-768d #16 (1.0965)

- `prototypes/parsing_service_simple/app/storage.py::_sha256` lines 54-55
- `prototypes/parsing_service/app/storage/canonical_package.py::_sha256_bytes` lines 72-73
- `packages/db/src/artifact-store.ts::sha256` lines 65-67

## c43bcb485ccf275e — adjudicated_positive

voyage-4-nano-256d #17 (1.0995), voyage-4-nano-512d #17 (1.1001), pplx-v1-0.6b-1024d #21 (1.0590), pplx-v1-0.6b-512d #22 (1.0546), jina-v2-code-768d #28 (1.0437)

- `prototypes/studio/api/batch_extractions.ts::<unknown>` lines 45-61
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 137-145

## 8362795ea5ae3be9 — adjudicated_positive

pplx-v1-0.6b-512d #18 (1.0703), pplx-v1-0.6b-1024d #19 (1.0677), jina-v2-code-768d #31 (1.0365), voyage-4-nano-512d #31 (1.0511), voyage-4-nano-256d #32 (1.0498), qwen3-0.6b-1024d #35 (1.0556), qwen3-0.6b-512d #36 (1.0631)

- `prototypes/parsing_service_simple/app/storage.py::_markdown_bytes` lines 74-81
- `prototypes/parsing_service/app/storage/canonical_package.py::_markdown_bytes` lines 147-157

## 5c1c4e16c3752d0c — adjudicated_positive

voyage-4-nano-256d #18 (1.0942), voyage-4-nano-512d #18 (1.0960)

- `packages/extraction/src/postgres-persistence.ts::stableUuid` lines 79-83
- `packages/db/src/project-store.ts::stableUuid` lines 343-348
- `packages/extraction/src/batch-worker.ts::fingerprintId` lines 14-18

## 3dec022fa5bdba54 — adjudicated_negative

qwen3-0.6b-512d #18 (1.0998)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 877-881
- `packages/db/src/project-store.ts::<unknown>` lines 89-93
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1527-1531

## fbda304a04064a22 — adjudicated_negative

qwen3-0.6b-1024d #18 (1.0971)

- `prototypes/studio/src/projectContexts/batchExtractions.ts::createBatchSchemaSuggestion` lines 122-140
- `packages/db/src/project-store.ts::createBatchSchemaSuggestion` lines 1098-1167
- `prototypes/studio/api/batch_schema_suggestions.ts::create` lines 106-134
- `packages/db/src/project-store.ts::create` lines 1099-1132
- `packages/db/src/project-store.ts::getBatchSchemaSuggestion` lines 1168-1182
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 128-148
- `packages/db/src/project-store.ts::listBatchSchemaSuggestions` lines 1183-1208
- `prototypes/studio/src/projectContexts/batchExtractions.ts::listBatchSchemaSuggestions` lines 141-149
- `prototypes/studio/api/batch_schema_suggestions.ts::list` lines 136-154
- `prototypes/studio/api/batch_schema_suggestions.ts::read` lines 156-166
- `prototypes/studio/api/batch_schema_suggestions.ts::retry` lines 252-262
- `packages/db/src/project-store.ts::<unknown>` lines 1258-1304
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 37-117
- `packages/db/src/project-store.ts::retryBatchSchemaSuggestion` lines 1257-1314
- `prototypes/studio/src/projectContexts/batchExtractions.ts::retryBatchSchemaSuggestion` lines 191-204
- `prototypes/studio/src/projectContexts/batchExtractions.ts::runBatchSchemaSuggestion` lines 174-189
- `packages/db/src/project-store.ts::loadBatchSchemaSuggestion` lines 243-326

## af710c32a5be1f24 — adjudicated_positive

jina-v2-code-768d #19 (1.0832), voyage-4-nano-512d #21 (1.0762), voyage-4-nano-256d #22 (1.0785), qwen3-0.6b-1024d #24 (1.0828), qwen3-0.6b-512d #25 (1.0846), pplx-v1-0.6b-512d #25 (1.0453), pplx-v1-0.6b-1024d #26 (1.0420)

- `prototypes/parsing_service_simple/app/main.py::__call__` lines 46-66
- `prototypes/parsing_service/app/api/request_admission.py::__call__` lines 23-51

## 6c05aa97e376ebe1 — adjudicated_positive

voyage-4-nano-512d #19 (1.0890), voyage-4-nano-256d #21 (1.0799), jina-v2-code-768d #23 (1.0604), qwen3-0.6b-512d #32 (1.0721), qwen3-0.6b-1024d #32 (1.0612), pplx-v1-0.6b-512d #46 (0.9904), pplx-v1-0.6b-1024d #47 (0.9944)

- `prototypes/studio/api/_project_operations.ts::durableFailure` lines 33-42
- `packages/extraction/src/batch-worker.ts::durableFailure` lines 19-25

## 0af22d0ea82eedf7 — adjudicated_positive

voyage-4-nano-256d #19 (1.0839), voyage-4-nano-512d #20 (1.0853), pplx-v1-0.6b-512d #47 (0.9886), pplx-v1-0.6b-1024d #49 (0.9782)

- `packages/extraction/src/postgres-persistence.ts::canonicalIds` lines 66-68
- `packages/db/src/project-store.ts::canonicalSourceDocumentIds` lines 328-330

## 39346d0439728459 — adjudicated_negative

qwen3-0.6b-512d #19 (1.0991)

- `prototypes/studio/src/projectContexts/batchExtractions.ts::createBatchSchemaSuggestion` lines 122-140
- `packages/db/src/project-store.ts::createBatchSchemaSuggestion` lines 1098-1167
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 37-117
- `packages/db/src/project-store.ts::create` lines 1099-1132
- `packages/db/src/project-store.ts::listBatchSchemaSuggestions` lines 1183-1208
- `prototypes/studio/src/projectContexts/batchExtractions.ts::listBatchSchemaSuggestions` lines 141-149
- `prototypes/studio/api/batch_schema_suggestions.ts::list` lines 136-154
- `prototypes/studio/api/batch_schema_suggestions.ts::read` lines 156-166
- `prototypes/studio/api/batch_schema_suggestions.ts::retry` lines 252-262
- `prototypes/studio/src/projectContexts/batchExtractions.ts::runBatchSchemaSuggestion` lines 174-189

## b23a29517107a9a9 — adjudicated_positive

qwen3-0.6b-1024d #20 (1.0877), qwen3-0.6b-512d #21 (1.0928), voyage-4-nano-512d #38 (1.0376), pplx-v1-0.6b-512d #40 (1.0079), pplx-v1-0.6b-1024d #41 (1.0015)

- `prototypes/parsing_service_simple/app/main.py::download_task_zip` lines 292-302
- `prototypes/parsing_service/app/api/routes_artifacts.py::download_task_zip` lines 46-68

## 1bd66100b6585cef — adjudicated_positive

voyage-4-nano-256d #20 (1.0815), voyage-4-nano-512d #24 (1.0663), qwen3-0.6b-1024d #37 (1.0537), qwen3-0.6b-512d #43 (1.0489)

- `prototypes/parsing_service_simple/app/storage.py::canonical_task_id` lines 41-45
- `prototypes/parsing_service/app/storage/paths.py::validate_task_id` lines 27-33

## 3602456fd033bae8 — unreviewed

jina-v2-code-768d #22 (1.0652)

- `prototypes/parsing_service_simple/app/main.py::get_task_markdown` lines 261-271
- `prototypes/parsing_service/app/api/routes_documents.py::get_task_markdown` lines 77-80
- `prototypes/parsing_service/app/api/routes_documents.py::canonical_markdown` lines 34-41
- `prototypes/parsing_service_simple/app/storage.py::read_markdown` lines 290-294

## af80b2a4dd2a77da — unreviewed

qwen3-0.6b-1024d #23 (1.0832), qwen3-0.6b-512d #26 (1.0834), jina-v2-code-768d #32 (1.0338)

- `prototypes/parsing_service_simple/app/main.py::get_task_document` lines 275-286
- `prototypes/parsing_service/app/api/routes_documents.py::get_task_document` lines 85-88
- `prototypes/parsing_service/app/api/routes_documents.py::read_stored_parsed_document` lines 22-31
- `prototypes/parsing_service/app/storage/manifests.py::read_parsed_document` lines 260-282
- `prototypes/parsing_service_simple/app/storage.py::read_parsed_document` lines 278-288

## 394fa5384ef6167f — known_positive

pplx-v1-0.6b-512d #23 (1.0534), pplx-v1-0.6b-1024d #23 (1.0503)

- `prototypes/studio/shared/template.ts::stripDescriptions` lines 90-101
- `packages/extraction/src/schema.ts::stripDescriptions` lines 265-272

## d3fb063977f0409c — known_positive

pplx-v1-0.6b-512d #24 (1.0500), pplx-v1-0.6b-1024d #24 (1.0500), jina-v2-code-768d #25 (1.0500), voyage-4-nano-256d #31 (1.0500), voyage-4-nano-512d #32 (1.0500), qwen3-0.6b-1024d #40 (1.0500), qwen3-0.6b-512d #41 (1.0500)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 676-678
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1183-1187

## 250bf60294b03672 — unreviewed

jina-v2-code-768d #24 (1.0544)

- `prototypes/parsing_service_simple/app/tasks.py::_package_version` lines 30-34
- `prototypes/parsing_service/app/models/parser.py::_package_version` lines 19-23
- `prototypes/parsing_service/app/parsing/orchestrator.py::package_version` lines 144-148

## b3da501a53c4dc95 — unreviewed

qwen3-0.6b-512d #24 (1.0860)

- `prototypes/parsing_service_simple/app/main.py::get_task_markdown` lines 261-271
- `prototypes/parsing_service/app/api/routes_documents.py::get_task_markdown` lines 77-80

## d2edf102f1f07f58 — unreviewed

qwen3-0.6b-1024d #25 (1.0824), pplx-v1-0.6b-512d #32 (1.0209), pplx-v1-0.6b-1024d #39 (1.0067)

- `prototypes/parsing_service_simple/app/main.py::get_task_markdown` lines 261-271
- `prototypes/parsing_service/app/api/routes_documents.py::get_task_markdown` lines 77-80
- `prototypes/parsing_service/app/api/routes_documents.py::canonical_markdown` lines 34-41

## 264a1324522b974f — unreviewed

pplx-v1-0.6b-1024d #25 (1.0421)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 933-943
- `packages/db/src/project-store.ts::<unknown>` lines 149-160
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 894-905
- `packages/db/src/project-store.ts::<unknown>` lines 109-117
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 358-365
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 413-424
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 385-392

## 6feead353bf95c95 — unreviewed

jina-v2-code-768d #26 (1.0451), pplx-v1-0.6b-512d #30 (1.0248), pplx-v1-0.6b-1024d #31 (1.0261), voyage-4-nano-512d #36 (1.0399), voyage-4-nano-256d #38 (1.0383), qwen3-0.6b-1024d #44 (1.0434), qwen3-0.6b-512d #49 (1.0436)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 686-689
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1203-1211

## 3da70ea49efe9609 — unreviewed

pplx-v1-0.6b-512d #26 (1.0391), jina-v2-code-768d #27 (1.0443), pplx-v1-0.6b-1024d #28 (1.0322), qwen3-0.6b-1024d #34 (1.0563), qwen3-0.6b-512d #40 (1.0579), voyage-4-nano-256d #42 (1.0298), voyage-4-nano-512d #42 (1.0306)

- `packages/extraction/src/postgres-persistence.ts::loadExtractionInputs` lines 489-518
- `packages/extraction/src/postgres-persistence.ts::loadExtractionInputs` lines 1614-1641
- `packages/extraction/src/postgres-persistence.ts::loadExtractionInputs` lines 948-979

## 486691a44540c0d0 — unreviewed

qwen3-0.6b-1024d #26 (1.0795)

- `prototypes/studio/src/projectContexts/batchExtractions.ts::updateBatchSchemaSuggestionDraft` lines 151-172
- `packages/db/src/project-store.ts::updateBatchSchemaSuggestionDraft` lines 1209-1256
- `packages/db/src/project-store.ts::<unknown>` lines 1215-1246
- `prototypes/studio/api/batch_schema_suggestions.ts::updateDraft` lines 168-202

## d849db7b583d7f20 — unreviewed

qwen3-0.6b-512d #27 (1.0788)

- `prototypes/studio/src/projectContexts/batchExtractions.ts::updateBatchSchemaSuggestionDraft` lines 151-172
- `packages/db/src/project-store.ts::updateBatchSchemaSuggestionDraft` lines 1209-1256
- `prototypes/studio/api/batch_schema_suggestions.ts::updateDraft` lines 168-202

## ac1da618a51f93f7 — unreviewed

qwen3-0.6b-1024d #27 (1.0755)

- `prototypes/studio/src/schemaRevisions.ts::listSchemaRevisions` lines 66-81
- `packages/db/src/project-store.ts::listSchemaRevisions` lines 1496-1520
- `prototypes/studio/src/currentSchemaRevision.ts::listRevisions` lines 145-148
- `prototypes/studio/api/extraction_schemas.ts::createGetExtractionSchemas` lines 23-66
- `prototypes/studio/src/schemaRevisions.ts::listExtractionSchemas` lines 24-34
- `packages/db/src/project-store.ts::listExtractionSchemas` lines 1366-1411
- `prototypes/studio/api/extraction_schemas.ts::GET` lines 26-65
- `prototypes/studio/api/schema_revisions.ts::GET` lines 55-125
- `prototypes/studio/src/schemaRevisions.ts::getSchemaRevision` lines 83-95
- `packages/db/src/project-store.ts::getSchemaRevision` lines 1521-1545
- `prototypes/studio/api/_schema_edit.ts::loadOwnedSchemaRevision` lines 120-142
- `packages/db/src/project-store.ts::ownedSchemaRevision` lines 81-122
- `packages/db/src/project-store.ts::currentHead` lines 1447-1455
- `prototypes/studio/src/currentSchemaRevision.ts::getRevision` lines 149-153

## 6d11364b49f8f584 — unreviewed

pplx-v1-0.6b-512d #27 (1.0382)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 710-735
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1289-1360
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 606-643
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1697-1724
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1091-1118
- `packages/db/src/project-store.ts::create` lines 1099-1132
- `packages/db/src/project-store.ts::<unknown>` lines 1258-1304
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 37-117
- `packages/db/src/project-store.ts::<unknown>` lines 1215-1246
- `packages/db/src/project-store.ts::<unknown>` lines 1100-1132
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 128-148
- `packages/db/src/project-store.ts::getBatchSchemaSuggestion` lines 1168-1182
- `packages/db/src/project-store.ts::loadBatchSchemaSuggestion` lines 243-326
- `packages/db/src/project-store.ts::startBatchSchemaSuggestionSource` lines 1615-1641
- `packages/db/src/project-store.ts::completeBatchSchemaSuggestionSource` lines 1642-1678
- `packages/db/src/project-store.ts::<unknown>` lines 1621-1640
- `packages/db/src/project-store.ts::<unknown>` lines 1649-1677
- `packages/db/src/project-store.ts::completeBatchSchemaSuggestionMerge` lines 1689-1728
- `packages/db/src/project-store.ts::startBatchSchemaSuggestionMerge` lines 1679-1688

## ac93f9c94696b500 — unreviewed

pplx-v1-0.6b-1024d #27 (1.0374)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 710-735
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1289-1360
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 606-643
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1697-1724
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1091-1118
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 37-117
- `packages/db/src/project-store.ts::<unknown>` lines 1258-1304
- `packages/db/src/project-store.ts::<unknown>` lines 1215-1246

## 6fb7c0e8a2f24e76 — known_positive

pplx-v1-0.6b-512d #28 (1.0354), pplx-v1-0.6b-1024d #30 (1.0261), jina-v2-code-768d #41 (1.0093), qwen3-0.6b-512d #46 (1.0458)

- `__benchmark__/typescript/type3.ts::collectInstructions` lines 17-31
- `packages/extraction/src/schema.ts::compileInstructions` lines 274-289
- `prototypes/studio/shared/template.ts::compileInstructions` lines 103-118

## ec5a657cc94f8082 — known_positive

voyage-4-nano-256d #28 (1.0554), voyage-4-nano-512d #28 (1.0525)

- `__benchmark__/typescript/type3.ts::collectInstructions` lines 17-31
- `packages/extraction/src/schema.ts::compileInstructions` lines 274-289

## ecdc9072a3e28d41 — unreviewed

qwen3-0.6b-512d #28 (1.0776)

- `prototypes/studio/src/schemaRevisions.ts::listSchemaRevisions` lines 66-81
- `packages/db/src/project-store.ts::listSchemaRevisions` lines 1496-1520
- `packages/db/src/project-store.ts::listExtractionSchemas` lines 1366-1411
- `prototypes/studio/src/schemaRevisions.ts::listExtractionSchemas` lines 24-34
- `prototypes/studio/api/extraction_schemas.ts::GET` lines 26-65
- `prototypes/studio/api/extraction_schemas.ts::createGetExtractionSchemas` lines 23-66
- `prototypes/studio/api/schema_revisions.ts::GET` lines 55-125
- `prototypes/studio/src/currentSchemaRevision.ts::listRevisions` lines 145-148

## d77f7029dcbc50ed — unreviewed

pplx-v1-0.6b-512d #29 (1.0267), pplx-v1-0.6b-1024d #29 (1.0274), jina-v2-code-768d #33 (1.0304), voyage-4-nano-512d #41 (1.0314), qwen3-0.6b-1024d #43 (1.0445), voyage-4-nano-256d #43 (1.0294)

- `packages/extraction/src/postgres-persistence.ts::scheduleBatch` lines 706-751
- `packages/extraction/src/postgres-persistence.ts::scheduleBatch` lines 1283-1397

## f31bec74661e3e19 — unreviewed

qwen3-0.6b-1024d #29 (1.0702), qwen3-0.6b-512d #33 (1.0685), jina-v2-code-768d #45 (1.0027)

- `prototypes/studio/src/schemaRevisions.ts::renameExtractionSchema` lines 36-51
- `packages/db/src/project-store.ts::renameExtractionSchema` lines 1412-1432

## f96276cbf1947645 — unreviewed

voyage-4-nano-256d #29 (1.0531), voyage-4-nano-512d #29 (1.0525)

- `packages/extraction/src/postgres-persistence.ts::ownedRepresentation` lines 910-946
- `packages/db/src/project-store.ts::ownedSourceRepresentationDescriptor` lines 124-163
- `packages/extraction/src/postgres-persistence.ts::ownedInputs` lines 852-908
- `packages/extraction/src/postgres-persistence.ts::claimedInputs` lines 1494-1574

## 4f2d34a47edf81eb — unreviewed

jina-v2-code-768d #29 (1.0407)

- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 1086-1139
- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 1691-1745
- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 604-659
- `packages/extraction/src/module.ts::persistTerminal` lines 354-386
- `packages/extraction/src/module.ts::<unknown>` lines 115-139

## 17184aaed4431d9a — unreviewed

qwen3-0.6b-512d #29 (1.0765)

- `prototypes/studio/src/projectContexts/batchExtractions.ts::retryBatchSchemaSuggestion` lines 191-204
- `packages/db/src/project-store.ts::retryBatchSchemaSuggestion` lines 1257-1314

## c5ee09dfd6229208 — unreviewed

voyage-4-nano-256d #30 (1.0522), voyage-4-nano-512d #30 (1.0521), jina-v2-code-768d #47 (1.0013)

- `prototypes/studio/server/static.ts::<unknown>` lines 65-65
- `prototypes/studio/shared/studioBasePath.ts::<unknown>` lines 19-23

## fbd6dd5127783f3d — unreviewed

jina-v2-code-768d #30 (1.0374)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1091-1118
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1697-1724
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 606-643
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1289-1360
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 710-735
- `packages/db/src/project-store.ts::<unknown>` lines 1100-1132
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 37-117
- `packages/db/src/project-store.ts::<unknown>` lines 1258-1304
- `packages/db/src/project-store.ts::<unknown>` lines 1215-1246
- `packages/db/src/project-store.ts::<unknown>` lines 1649-1677
- `packages/db/src/project-store.ts::<unknown>` lines 1621-1640
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 801-806
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 815-829
- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 1417-1446
- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 764-774
- `packages/extraction/src/module.ts::listBatches` lines 250-255
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1421-1445
- `packages/extraction/src/postgres-persistence.ts::read` lines 708-708
- `packages/db/src/project-store.ts::createInternalProjectWorkerStore` lines 1549-1750
- `packages/extraction/src/postgres-suggested-batch.ts::persistSuggestedBatch` lines 10-152
- `packages/extraction/src/postgres-suggested-batch.ts::<unknown>` lines 128-148

## 21e0100c40348d29 — unreviewed

pplx-v1-0.6b-512d #31 (1.0229), qwen3-0.6b-1024d #41 (1.0475), qwen3-0.6b-512d #44 (1.0475)

- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 604-659
- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 1691-1745
- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 1086-1139
- `packages/extraction/src/module.ts::persistTerminal` lines 354-386

## 7fb89f4fed3f1124 — known_positive

qwen3-0.6b-1024d #31 (1.0628), qwen3-0.6b-512d #34 (1.0656)

- `prototypes/studio/shared/template.ts::stripDescriptions` lines 90-101
- `packages/extraction/src/schema.ts::stripDescriptions` lines 265-272
- `__benchmark__/typescript/type3.ts::omitDescriptionsDeep` lines 6-15

## 2f08a319663eeb5f — unreviewed

pplx-v1-0.6b-1024d #32 (1.0211), qwen3-0.6b-1024d #33 (1.0567), qwen3-0.6b-512d #37 (1.0599), jina-v2-code-768d #39 (1.0150)

- `prototypes/parsing_service_simple/app/docling_parser.py::_deterministic_id` lines 1019-1029
- `prototypes/parsing_service/app/models/parsed_document_v2.py::deterministic_id` lines 87-92

## 8506c28ca48e6c1e — unreviewed

pplx-v1-0.6b-512d #33 (1.0182), pplx-v1-0.6b-1024d #38 (1.0098), qwen3-0.6b-1024d #47 (1.0397)

- `prototypes/parsing_service_simple/app/main.py::create_task` lines 146-226
- `prototypes/parsing_service/app/api/routes_tasks.py::create_task` lines 25-81

## 31c63f0c7007e2b1 — unreviewed

pplx-v1-0.6b-1024d #33 (1.0195), voyage-4-nano-512d #35 (1.0407), voyage-4-nano-256d #37 (1.0402)

- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 1086-1139
- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 1691-1745
- `packages/extraction/src/postgres-persistence.ts::persistExtraction` lines 604-659

## 85d2b99461699c77 — unreviewed

voyage-4-nano-256d #33 (1.0464), jina-v2-code-768d #44 (1.0035)

- `prototypes/studio/shared/batchExtraction.contract.ts::<unknown>` lines 155-157
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 823-823

## 360265b42d25ae80 — unreviewed

voyage-4-nano-512d #33 (1.0415), voyage-4-nano-256d #34 (1.0447)

- `prototypes/parsing_service_simple/app/docling_parser.py::_validate_publication` lines 1051-1137
- `prototypes/parsing_service/app/parsing/v2_publication.py::validate_publication` lines 361-452

## e31acb3d08fbd514 — unreviewed

jina-v2-code-768d #34 (1.0244), pplx-v1-0.6b-1024d #40 (1.0030), pplx-v1-0.6b-512d #41 (1.0072)

- `packages/extraction/src/postgres-persistence.ts::readCanonicalParsedDocument` lines 520-530
- `packages/extraction/src/postgres-persistence.ts::readCanonicalParsedDocument` lines 1643-1671
- `packages/extraction/src/postgres-persistence.ts::readCanonicalParsedDocument` lines 981-990

## afbccf3459ce898c — known_hard_negative

voyage-4-nano-512d #34 (1.0414), voyage-4-nano-256d #36 (1.0419)

- `__benchmark__/typescript/hard_negatives.ts::blankDescriptions` lines 5-15
- `packages/extraction/src/schema.ts::stripDescriptions` lines 265-272

## 69f9d54a07fab996 — unreviewed

pplx-v1-0.6b-512d #34 (1.0175)

- `prototypes/parsing_service_simple/app/docling_parser.py::_deterministic_id` lines 1019-1029
- `prototypes/parsing_service/app/models/parsed_document_v2.py::deterministic_id` lines 87-92
- `prototypes/parsing_service/app/models/parsed_document_v2.py::deterministic_block_id` lines 95-96
- `prototypes/parsing_service/app/models/parsed_document_v2.py::deterministic_table_id` lines 99-100
- `prototypes/parsing_service/app/models/parsed_document_v2.py::deterministic_occurrence_id` lines 107-110

## 3658f5b71d16633f — unreviewed

pplx-v1-0.6b-1024d #35 (1.0147), pplx-v1-0.6b-512d #36 (1.0150)

- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 764-774
- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 1417-1446
- `packages/extraction/src/module.ts::listBatches` lines 250-255
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1421-1445

## 715c45f138db074e — unreviewed

jina-v2-code-768d #35 (1.0236)

- `packages/extraction/src/postgres-persistence.ts::scheduleSuggestedBatch` lines 753-762
- `packages/extraction/src/postgres-persistence.ts::scheduleSuggestedBatch` lines 1399-1415
- `packages/extraction/src/module.ts::scheduleSuggestedBatch` lines 245-249

## 032cd863b8c1ee36 — unreviewed

qwen3-0.6b-512d #35 (1.0634)

- `prototypes/studio/src/schemaRevisions.ts::getSchemaRevision` lines 83-95
- `packages/db/src/project-store.ts::getSchemaRevision` lines 1521-1545
- `prototypes/studio/api/_schema_edit.ts::loadOwnedSchemaRevision` lines 120-142
- `packages/db/src/project-store.ts::ownedSchemaRevision` lines 81-122
- `prototypes/studio/src/currentSchemaRevision.ts::getRevision` lines 149-153

## aa1a66236b306b99 — unreviewed

voyage-4-nano-256d #35 (1.0435)

- `prototypes/parsing_service_simple/app/main.py::_http_metadata` lines 69-79
- `prototypes/parsing_service/app/api/deps.py::load_metadata` lines 25-35

## dc43d5c907c41c77 — unreviewed

pplx-v1-0.6b-1024d #36 (1.0125), pplx-v1-0.6b-512d #38 (1.0142), voyage-4-nano-256d #46 (1.0159), voyage-4-nano-512d #46 (1.0129)

- `packages/extraction/src/postgres-persistence.ts::readDocumentExtractions` lines 542-602
- `packages/extraction/src/postgres-persistence.ts::readDocumentExtractions` lines 1012-1084
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 545-601
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1015-1083

## e02a622a268523be — unreviewed

qwen3-0.6b-1024d #36 (1.0544), qwen3-0.6b-512d #38 (1.0593)

- `prototypes/studio/api/project_contexts.fixture.ts::getDocumentReopenSnapshot` lines 38-57
- `packages/db/src/project-store.ts::getDocumentReopenSnapshot` lines 870-987
- `prototypes/studio/src/projectContexts/transport.ts::getDocumentReopenSnapshot` lines 133-147
- `prototypes/studio/api/document_reopen.ts::getDocumentReopen` lines 166-286
- `prototypes/studio/api/document_reopen.ts::reopenResponse` lines 92-160
- `prototypes/studio/api/document_reopen.ts::createGetDocumentReopen` lines 162-287
- `prototypes/studio/src/projectNavigation.ts::<unknown>` lines 174-183

## 0f2b6b1f78781bdf — unreviewed

jina-v2-code-768d #36 (1.0233)

- `prototypes/studio/shared/template.ts::stripDescriptions` lines 90-101
- `packages/extraction/src/schema.ts::stripDescriptions` lines 265-272
- `__benchmark__/typescript/type3.ts::omitDescriptionsDeep` lines 6-15
- `__benchmark__/typescript/hard_negatives.ts::blankDescriptions` lines 5-15
- `__benchmark__/typescript/type2.ts::removeMetadataDescriptions` lines 5-16

## 2753091e5bbb1821 — unreviewed

voyage-4-nano-512d #37 (1.0378), voyage-4-nano-256d #39 (1.0367)

- `packages/extraction/src/postgres-persistence.ts::claimBatch` lines 780-796
- `packages/db/src/project-store.ts::claimBatchSchemaSuggestion` lines 1556-1601

## a1c2e3ea65bbdf01 — unreviewed

jina-v2-code-768d #37 (1.0182)

- `packages/extraction/src/postgres-persistence.ts::readDocumentExtractions` lines 542-602
- `packages/extraction/src/postgres-persistence.ts::readDocumentExtractions` lines 1012-1084
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 545-601
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1015-1083
- `packages/db/src/project-store.ts::<unknown>` lines 875-986
- `packages/db/src/project-store.ts::<unknown>` lines 1316-1364
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 493-504
- `packages/db/src/project-store.ts::<unknown>` lines 795-817
- `packages/db/src/project-store.ts::<unknown>` lines 757-789
- `packages/extraction/src/postgres-persistence.ts::loadResearcherExtraction` lines 430-444
- `packages/extraction/src/postgres-persistence.ts::readExtraction` lines 992-1002
- `packages/extraction/src/postgres-persistence.ts::readExtraction` lines 1673-1681
- `packages/extraction/src/postgres-persistence.ts::readExtraction` lines 532-532
- `packages/extraction/src/postgres-persistence.ts::loadExtraction` lines 149-194
- `packages/db/src/project-store.ts::<unknown>` lines 1367-1410
- `packages/db/src/project-store.ts::<unknown>` lines 1465-1488

## e8f8f690e137e4f5 — unreviewed

pplx-v1-0.6b-512d #37 (1.0145)

- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 661-704
- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 1141-1259
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 668-695
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1160-1232
- `packages/extraction/src/module.ts::prepareReview` lines 163-177
- `packages/extraction/src/module.ts::finalizeReview` lines 179-230

## 01baa10574c31458 — unreviewed

pplx-v1-0.6b-1024d #37 (1.0111)

- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 661-704
- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 1141-1259
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 668-695
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1160-1232

## 40183ccb775a81fb — unreviewed

qwen3-0.6b-1024d #38 (1.0530), qwen3-0.6b-512d #39 (1.0590)

- `prototypes/studio/src/api.ts::finalizeExtractionReview` lines 140-152
- `packages/extraction/src/module.ts::finalizeReview` lines 179-230
- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 661-704
- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 1141-1259
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 668-695
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1160-1232
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1235-1247
- `prototypes/studio/api/extractions.ts::review` lines 97-117

## 7bb0c2fad0ed007f — unreviewed

jina-v2-code-768d #38 (1.0180)

- `prototypes/parsing_service_simple/app/storage.py::_safe_display_filename` lines 125-128
- `prototypes/parsing_service/app/storage/paths.py::safe_display_filename` lines 54-75

## 001cc053a5311132 — unreviewed

qwen3-0.6b-1024d #39 (1.0512), qwen3-0.6b-512d #50 (1.0427)

- `prototypes/studio/src/projectContexts/transport.ts::renameProjectContext` lines 59-61
- `packages/db/src/project-store.ts::renameProjectContext` lines 747-755

## 26407fd81988f46e — unreviewed

pplx-v1-0.6b-512d #39 (1.0079), pplx-v1-0.6b-1024d #46 (0.9960)

- `prototypes/parsing_service_simple/app/main.py::get_task_document` lines 275-286
- `prototypes/parsing_service/app/api/routes_documents.py::get_task_document` lines 85-88
- `prototypes/parsing_service/app/api/routes_documents.py::read_stored_parsed_document` lines 22-31

## b9efa2d07a506fa6 — unreviewed

voyage-4-nano-512d #39 (1.0338), voyage-4-nano-256d #40 (1.0328)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 710-735
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1289-1360
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 606-643

## ef557b3ccccf5b0d — unreviewed

voyage-4-nano-512d #40 (1.0327), voyage-4-nano-256d #41 (1.0323)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1091-1118
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1697-1724

## 77c1db98b41456b5 — unreviewed

jina-v2-code-768d #40 (1.0125)

- `prototypes/studio/src/schemaRevisions.ts::listSchemaRevisions` lines 66-81
- `packages/db/src/project-store.ts::listSchemaRevisions` lines 1496-1520
- `packages/db/src/project-store.ts::listExtractionSchemas` lines 1366-1411
- `prototypes/studio/src/schemaRevisions.ts::listExtractionSchemas` lines 24-34

## 0777f6296dce50b7 — known_positive

pplx-v1-0.6b-512d #42 (1.0000), pplx-v1-0.6b-1024d #44 (1.0000), jina-v2-code-768d #50 (1.0000)

- `prototypes/studio/shared/batchExtraction.contract.ts::<unknown>` lines 29-29
- `prototypes/studio/shared/batchSchemaSuggestion.contract.ts::<unknown>` lines 13-13

## b7470121255585a2 — unreviewed

jina-v2-code-768d #42 (1.0077), pplx-v1-0.6b-512d #49 (0.9697)

- `prototypes/parsing_service_simple/app/main.py::get_system_status` lines 135-143
- `prototypes/parsing_service/app/api/routes_system.py::get_system_status` lines 31-38

## e762607714e04078 — unreviewed

qwen3-0.6b-512d #42 (1.0498), qwen3-0.6b-1024d #42 (1.0462)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 933-943
- `packages/db/src/project-store.ts::<unknown>` lines 149-160
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 894-905
- `packages/db/src/project-store.ts::<unknown>` lines 109-117

## 607a4e3294c0f098 — unreviewed

pplx-v1-0.6b-1024d #42 (1.0000), pplx-v1-0.6b-512d #45 (1.0000)

- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 98-98
- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 108-108
- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 65-65

## 9d48f0c5bdd64145 — known_positive

pplx-v1-0.6b-512d #43 (1.0000), pplx-v1-0.6b-1024d #43 (1.0000), voyage-4-nano-512d #50 (1.0000)

- `prototypes/studio/src/providerConfig/useProviderConfigDraft.ts::<unknown>` lines 53-53
- `prototypes/studio/src/providerConfig/useProviderConfigDraft.ts::<unknown>` lines 74-74

## 6c340aa57354ea0b — unreviewed

jina-v2-code-768d #43 (1.0051), qwen3-0.6b-1024d #50 (1.0322)

- `packages/extraction-result-export/src/batch.ts::extractionRecords` lines 22-39
- `packages/extraction/src/module.ts::extractionRecords` lines 399-401

## 2a26b8fb995c2d62 — unreviewed

voyage-4-nano-512d #43 (1.0262), voyage-4-nano-256d #44 (1.0248)

- `prototypes/parsing_service/app/models/parser.py::_package_version` lines 19-23
- `prototypes/parsing_service/app/parsing/orchestrator.py::package_version` lines 144-148

## 4f3626515b8fc513 — known_positive

pplx-v1-0.6b-512d #44 (1.0000), pplx-v1-0.6b-1024d #45 (1.0000), voyage-4-nano-512d #48 (1.0000)

- `packages/extraction/src/source-context.ts::<unknown>` lines 36-36
- `packages/extraction/src/source-context.ts::<unknown>` lines 64-64

## 883e7c4ddc0f5289 — unreviewed

voyage-4-nano-512d #44 (1.0228), voyage-4-nano-256d #45 (1.0242)

- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 764-774
- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 1417-1446

## 168f11b741199fe6 — unreviewed

voyage-4-nano-512d #45 (1.0143), voyage-4-nano-256d #47 (1.0151), pplx-v1-0.6b-512d #48 (0.9862), pplx-v1-0.6b-1024d #48 (0.9860)

- `packages/extraction/src/postgres-persistence.ts::scheduleSuggestedBatch` lines 753-762
- `packages/extraction/src/postgres-persistence.ts::scheduleSuggestedBatch` lines 1399-1415

## 78f55c2f15ce0a82 — unreviewed

qwen3-0.6b-512d #45 (1.0462), qwen3-0.6b-1024d #45 (1.0429)

- `prototypes/parsing_service_simple/app/storage.py::load_metadata` lines 177-188
- `prototypes/parsing_service/app/api/deps.py::load_metadata` lines 25-35
- `prototypes/parsing_service_simple/app/main.py::_http_metadata` lines 69-79
- `prototypes/parsing_service/app/storage/manifests.py::load_task_metadata` lines 34-38

## ec8c4b2251870fd0 — unreviewed

jina-v2-code-768d #46 (1.0021)

- `prototypes/studio/src/projectContexts/batchExtractions.ts::updateBatchSchemaSuggestionDraft` lines 151-172
- `packages/db/src/project-store.ts::updateBatchSchemaSuggestionDraft` lines 1209-1256

## 94bec612f9976dd7 — unreviewed

qwen3-0.6b-1024d #46 (1.0416)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 710-735
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1289-1360

## d9911954f8528684 — unreviewed

voyage-4-nano-512d #47 (1.0108), voyage-4-nano-256d #48 (1.0121)

- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 661-704
- `packages/extraction/src/postgres-persistence.ts::finalizeReview` lines 1141-1259

## 3cfd5cfc7563d3ce — unreviewed

qwen3-0.6b-512d #47 (1.0451)

- `packages/extraction/src/postgres-persistence.ts::scheduleBatch` lines 706-751
- `packages/extraction/src/postgres-persistence.ts::scheduleBatch` lines 1283-1397
- `packages/extraction/src/module.ts::scheduleBatch` lines 240-244

## 3980d5382bbb0275 — unreviewed

qwen3-0.6b-512d #48 (1.0444), qwen3-0.6b-1024d #49 (1.0370)

- `prototypes/studio/src/schemaRevisions.ts::appendSchemaRevision` lines 129-140
- `packages/db/src/project-store.ts::appendSchemaRevision` lines 1433-1495
- `packages/db/src/project-store.ts::initializeSchemaRevision` lines 1315-1365
- `prototypes/studio/src/schemaRevisions.ts::initializeSchemaRevision` lines 121-127

## d97c39441f54d42e — unreviewed

jina-v2-code-768d #48 (1.0006)

- `packages/extraction/src/postgres-persistence.ts::readBatch` lines 775-778
- `packages/extraction/src/postgres-persistence.ts::readBatch` lines 1448-1456
- `packages/extraction/src/postgres-persistence.ts::readBatchResults` lines 1458-1473
- `packages/extraction/src/postgres-persistence.ts::readBatchResults` lines 779-779
- `packages/extraction/src/module.ts::readBatchResults` lines 261-265
- `packages/extraction/src/module.ts::readBatch` lines 256-260
- `packages/extraction/src/postgres-persistence.ts::readBatchForResearcher` lines 1261-1281

## dc4d468de1ee9a9f — unreviewed

qwen3-0.6b-1024d #48 (1.0395)

- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 764-774
- `packages/extraction/src/postgres-persistence.ts::listBatches` lines 1417-1446
- `packages/extraction/src/module.ts::listBatches` lines 250-255
- `prototypes/studio/src/projectContexts/batchExtractions.ts::listBatchExtractions` lines 56-64
- `prototypes/studio/api/batch_extractions.ts::list` lines 120-146
- `prototypes/studio/api/batch_extractions.ts::read` lines 148-173
- `prototypes/studio/src/projectContexts/batchExtractions.ts::getBatchExtraction` lines 94-103
- `prototypes/studio/api/batch_extractions.ts::results` lines 179-204
- `prototypes/studio/src/projectContexts/batchExtractions.ts::getBatchExtractionResults` lines 109-120
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1421-1445

## d7b1678f58b25969 — unreviewed

jina-v2-code-768d #49 (1.0000), voyage-4-nano-512d #49 (1.0000)

- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 98-98
- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 108-108
- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 65-65
- `prototypes/studio/src/providerConfig/useProbeLifecycle.ts::<unknown>` lines 77-77

## e6b4e7863fb918d5 — unreviewed

voyage-4-nano-256d #49 (1.0019)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 668-695
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1160-1232

## 6f2e26a357c6fd27 — unreviewed

pplx-v1-0.6b-512d #50 (0.9689)

- `__benchmark__/python/type2.py::compute_file_digest` lines 23-28
- `prototypes/parsing_service/app/storage/canonical_package.py::_sha256_file` lines 76-81
- `__benchmark__/python/type3.py::hash_file_contents` lines 21-29
- `prototypes/parsing_service/app/storage/hashing.py::compute_sha256` lines 13-20

## f97e8ee486075f77 — unreviewed

pplx-v1-0.6b-1024d #50 (0.9680)

- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 883-893
- `packages/extraction/src/postgres-persistence.ts::<unknown>` lines 1533-1543

## b3da9e0f0b5c49e9 — unreviewed

voyage-4-nano-256d #50 (1.0019)

- `packages/extraction/src/postgres-persistence.ts::readBatch` lines 775-778
- `packages/extraction/src/postgres-persistence.ts::readBatch` lines 1448-1456
