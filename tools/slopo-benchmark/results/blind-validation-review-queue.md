# Slopo blind-validation review queue

Frozen configuration SHA-256: `3b0931bb9838907a1d59a79e402337dfa2adaca53394e32014e1124d7523fc94`

Queue SHA-256: `26a743767c1a8056bf35d7bdef41630d840c5b006f46366e28e336ed69db2f15`

Review the candidates in this shuffled order. Model identity, support, rank, and similarity scores are intentionally hidden. Mark a candidate positive only when all reported members form one coherent duplicate implementation or refactoring opportunity.

## HV-001

- `slopo/config.py::_require_positive_int` lines 238-242
- `slopo/config.py::_ensure_positive_int` lines 276-281

## HV-002

- `slopo/indexing/parsing/lang/csharp.py::_body_without_comments` lines 70-80
- `slopo/indexing/parsing/lang/elixir.py::_body_without_comments` lines 96-106
- `slopo/indexing/parsing/lang/javascript.py::_body_without_comments` lines 69-79
- `slopo/indexing/parsing/lang/rust.py::_body_without_comments` lines 62-72
- `slopo/indexing/parsing/lang/typescript.py::_body_without_comments` lines 69-79
- `slopo/indexing/parsing/lang/go.py::_body_without_comments` lines 76-86
- `slopo/indexing/parsing/lang/php.py::_body_without_comments` lines 68-78
- `slopo/indexing/parsing/lang/java.py::_body_without_comments` lines 62-72
- `slopo/indexing/parsing/lang/kotlin.py::_body_without_comments` lines 70-80
- `slopo/indexing/parsing/lang/python.py::_body_without_comments` lines 40-50

## HV-003

- `slopo/config.py::_optional_positive_int` lines 245-251
- `slopo/config.py::_optional_non_negative_int` lines 263-273
- `slopo/config.py::_optional_positive_float` lines 254-260

## HV-004

- `slopo/indexing/parsing/lang/javascript.py::_binding_name_node` lines 53-66
- `slopo/indexing/parsing/lang/typescript.py::_binding_name_node` lines 53-66
- `slopo/indexing/parsing/lang/csharp.py::_binding_name_node` lines 56-67
- `slopo/indexing/parsing/lang/java.py::_binding_name_node` lines 48-59
- `slopo/indexing/parsing/lang/rust.py::_binding_name_node` lines 48-59
- `slopo/indexing/parsing/lang/php.py::_binding_name_node` lines 53-65
- `slopo/indexing/parsing/lang/go.py::_binding_name_node` lines 48-63
- `slopo/indexing/parsing/lang/kotlin.py::_binding_name_node` lines 49-61
- `slopo/indexing/parsing/lang/elixir.py::_binding_name_node` lines 84-93

## HV-005

- `slopo/indexing/parsing/lang/go.py::_count_body_nodes` lines 97-101
- `slopo/indexing/parsing/lang/javascript.py::_count_body_nodes` lines 90-94
- `slopo/indexing/parsing/lang/rust.py::_count_body_nodes` lines 83-87
- `slopo/indexing/parsing/lang/typescript.py::_count_body_nodes` lines 90-94
- `slopo/indexing/parsing/lang/php.py::_count_body_nodes` lines 89-93
- `slopo/indexing/parsing/lang/csharp.py::_count_body_nodes` lines 91-95
- `slopo/indexing/parsing/lang/elixir.py::_count_body_nodes` lines 117-118

## HV-006

- `slopo/indexing/parsing/lang/csharp.py::parse` lines 22-26
- `slopo/indexing/parsing/lang/elixir.py::parse` lines 17-21
- `slopo/indexing/parsing/lang/kotlin.py::parse` lines 14-18
- `slopo/indexing/parsing/lang/typescript.py::parse` lines 20-24
- `slopo/indexing/parsing/lang/go.py::parse` lines 14-18
- `slopo/indexing/parsing/lang/php.py::parse` lines 19-23
- `slopo/indexing/parsing/lang/java.py::parse` lines 14-18
- `slopo/indexing/parsing/lang/python.py::parse` lines 12-16
- `slopo/indexing/parsing/lang/javascript.py::parse` lines 20-24
- `slopo/indexing/parsing/lang/rust.py::parse` lines 14-18

## HV-007

- `slopo/config.py::_require_str` lines 167-173
- `slopo/config.py::_optional_str` lines 176-182

## HV-008

- `slopo/analysis/rerank.py::rerank_cluster_pairs` lines 30-46
- `slopo/analysis/rerank.py::rerank_all_clusters` lines 49-61
- `slopo/analysis/clustering.py::reorder_clusters` lines 68-87

## HV-009

- `slopo/indexing/parsing/lang/csharp.py::_count_named_nodes` lines 108-112
- `slopo/indexing/parsing/lang/elixir.py::_count_named_nodes` lines 158-162
- `slopo/indexing/parsing/lang/rust.py::_count_named_nodes` lines 90-94
- `slopo/indexing/parsing/lang/javascript.py::_count_named_nodes` lines 97-101
- `slopo/indexing/parsing/lang/typescript.py::_count_named_nodes` lines 97-101
- `slopo/indexing/parsing/lang/kotlin.py::_count_named_nodes` lines 100-104
- `slopo/indexing/parsing/lang/go.py::_count_named_nodes` lines 104-108
- `slopo/indexing/parsing/lang/php.py::_count_named_nodes` lines 96-100
- `slopo/indexing/parsing/lang/java.py::_count_named_nodes` lines 90-94
- `slopo/indexing/parsing/lang/python.py::_count_named_nodes` lines 68-74

## HV-010

- `slopo/indexing/parsing/lang/csharp.py::_collect_units` lines 29-43
- `slopo/indexing/parsing/lang/go.py::_collect_units` lines 21-35
- `slopo/indexing/parsing/lang/javascript.py::_collect_units` lines 27-41
- `slopo/indexing/parsing/lang/rust.py::_collect_units` lines 21-35
- `slopo/indexing/parsing/lang/kotlin.py::_collect_units` lines 21-35
- `slopo/indexing/parsing/lang/typescript.py::_collect_units` lines 27-41
- `slopo/indexing/parsing/lang/php.py::_collect_units` lines 26-40
- `slopo/indexing/parsing/lang/java.py::_collect_units` lines 21-35
- `slopo/indexing/parsing/lang/elixir.py::_collect_units` lines 24-38
- `slopo/indexing/parsing/lang/python.py::_collect_units` lines 19-37

## HV-011

- `slopo/indexing/parsing/lang/csharp.py::_collect_comment_spans` lines 83-88
- `slopo/indexing/parsing/lang/elixir.py::_collect_comment_spans` lines 109-114
- `slopo/indexing/parsing/lang/javascript.py::_collect_comment_spans` lines 82-87
- `slopo/indexing/parsing/lang/rust.py::_collect_comment_spans` lines 75-80
- `slopo/indexing/parsing/lang/typescript.py::_collect_comment_spans` lines 82-87
- `slopo/indexing/parsing/lang/kotlin.py::_collect_comment_spans` lines 83-88
- `slopo/indexing/parsing/lang/go.py::_collect_comment_spans` lines 89-94
- `slopo/indexing/parsing/lang/php.py::_collect_comment_spans` lines 81-86
- `slopo/indexing/parsing/lang/java.py::_collect_comment_spans` lines 75-80
- `slopo/indexing/parsing/lang/python.py::_collect_comment_spans` lines 53-58

## HV-012

- `slopo/indexing/parsing/lang/javascript.py::_unit_name` lines 44-50
- `slopo/indexing/parsing/lang/typescript.py::_unit_name` lines 44-50
- `slopo/indexing/parsing/lang/php.py::_unit_name` lines 43-50
- `slopo/indexing/parsing/lang/kotlin.py::_unit_name` lines 38-46
- `slopo/indexing/parsing/lang/csharp.py::_unit_name` lines 46-53
- `slopo/indexing/parsing/lang/rust.py::_unit_name` lines 38-45
- `slopo/indexing/parsing/lang/java.py::_unit_name` lines 38-45
- `slopo/indexing/parsing/lang/go.py::_unit_name` lines 38-45
- `slopo/indexing/parsing/lang/elixir.py::_unit_name` lines 56-70

## HV-013

- `slopo/indexing/parsing/lang/go.py::_count_body_nodes` lines 97-101
- `slopo/indexing/parsing/lang/javascript.py::_count_body_nodes` lines 90-94
- `slopo/indexing/parsing/lang/rust.py::_count_body_nodes` lines 83-87
- `slopo/indexing/parsing/lang/typescript.py::_count_body_nodes` lines 90-94
- `slopo/indexing/parsing/lang/php.py::_count_body_nodes` lines 89-93
- `slopo/indexing/parsing/lang/csharp.py::_count_body_nodes` lines 91-95
- `slopo/indexing/parsing/lang/elixir.py::_count_body_nodes` lines 117-118
- `slopo/indexing/parsing/lang/kotlin.py::_count_body_nodes` lines 91-97
- `slopo/indexing/parsing/lang/python.py::_count_body_nodes` lines 61-65
- `slopo/indexing/parsing/lang/java.py::_count_body_nodes` lines 83-87
