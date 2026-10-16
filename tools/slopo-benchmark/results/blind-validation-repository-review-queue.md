# Slopo blind-validation review queue

Frozen configuration SHA-256: `a5fcf8fe859effb262162490f7482e62437e184936deafb7cecec8a7fbd6c0d7`

Queue SHA-256: `3ef79f3925f9dabc2ab73a016062e719b939d818633d2010321d699b2695b04b`

Review the candidates in this shuffled order. Model identity, support, rank, and similarity scores are intentionally hidden. Mark a candidate positive only when all reported members form one coherent duplicate implementation or refactoring opportunity.

## HV-001

- `src/slopo/indexing/parsing/lang/csharp.py::_collect_units` lines 29-43
- `src/slopo/indexing/parsing/lang/go.py::_collect_units` lines 21-35
- `src/slopo/indexing/parsing/lang/rust.py::_collect_units` lines 21-35
- `src/slopo/indexing/parsing/lang/javascript.py::_collect_units` lines 27-41
- `src/slopo/indexing/parsing/lang/kotlin.py::_collect_units` lines 21-35
- `src/slopo/indexing/parsing/lang/typescript.py::_collect_units` lines 27-41
- `src/slopo/indexing/parsing/lang/php.py::_collect_units` lines 26-40
- `src/slopo/indexing/parsing/lang/java.py::_collect_units` lines 21-35
- `src/slopo/indexing/parsing/lang/elixir.py::_collect_units` lines 24-38
- `src/slopo/indexing/parsing/lang/python.py::_collect_units` lines 19-37

## HV-002

- `tests/indexing/parsing/lang/test_elixir.py::test_body_node_count_counts_only_block_for_empty_body` lines 95-97
- `tests/indexing/parsing/lang/test_rust.py::test_body_node_count_counts_only_block_for_empty_body` lines 99-101
- `tests/indexing/parsing/lang/test_go.py::test_body_node_count_counts_only_block_for_empty_body` lines 90-92
- `tests/indexing/parsing/lang/test_php.py::test_body_node_count_counts_only_block_for_empty_body` lines 91-93
- `tests/indexing/parsing/lang/test_java.py::test_body_node_count_counts_only_block_for_empty_body` lines 88-90
- `tests/indexing/parsing/lang/test_kotlin.py::test_body_node_count_counts_only_block_for_empty_body` lines 97-99
- `tests/indexing/parsing/lang/test_javascript.py::test_body_node_count_counts_only_block_for_empty_body` lines 77-79
- `tests/indexing/parsing/lang/test_typescript.py::test_body_node_count_counts_only_block_for_empty_body` lines 99-101
- `tests/indexing/parsing/lang/test_csharp.py::test_body_node_count_counts_only_block_for_empty_body` lines 93-95
- `tests/indexing/parsing/lang/test_python.py::test_body_node_count_for_pass_body` lines 83-85

## HV-003

- `tests/indexing/parsing/lang/fixtures/csharp/Lambdas.cs::<unknown>` lines 13-17
- `tests/indexing/parsing/lang/fixtures/java/Lambdas.java::<unknown>` lines 14-17
- `tests/indexing/parsing/lang/fixtures/kotlin/Lambdas.kt::<unknown>` lines 10-13
- `tests/indexing/parsing/lang/fixtures/rust/Closures.rs::<unknown>` lines 17-20

## HV-004

- `tests/indexing/parsing/lang/test_csharp.py::lambdas` lines 37-38
- `tests/indexing/parsing/lang/test_kotlin.py::lambdas` lines 37-38
- `tests/indexing/parsing/lang/test_java.py::lambdas` lines 37-38

## HV-005

- `tests/indexing/parsing/lang/test_javascript.py::test_body_node_count_counts_expression_for_concise_arrow` lines 72-74
- `tests/indexing/parsing/lang/test_typescript.py::test_body_node_count_counts_expression_for_concise_arrow` lines 94-96

## HV-006

- `src/slopo/indexing/parsing/lang/csharp.py::parse` lines 22-26
- `src/slopo/indexing/parsing/lang/elixir.py::parse` lines 17-21
- `src/slopo/indexing/parsing/lang/rust.py::parse` lines 14-18
- `src/slopo/indexing/parsing/lang/javascript.py::parse` lines 20-24
- `src/slopo/indexing/parsing/lang/kotlin.py::parse` lines 14-18
- `src/slopo/indexing/parsing/lang/typescript.py::parse` lines 20-24
- `src/slopo/indexing/parsing/lang/go.py::parse` lines 14-18
- `src/slopo/indexing/parsing/lang/php.py::parse` lines 19-23
- `src/slopo/indexing/parsing/lang/java.py::parse` lines 14-18
- `src/slopo/indexing/parsing/lang/python.py::parse` lines 12-16

## HV-007

- `tests/indexing/parsing/lang/test_javascript.py::test_line_numbers_are_one_based_and_correct` lines 57-60
- `tests/indexing/parsing/lang/test_typescript.py::test_line_numbers_are_one_based_and_correct` lines 73-76
- `tests/indexing/parsing/lang/test_java.py::test_line_numbers_are_one_based_and_correct` lines 53-56
- `tests/indexing/parsing/lang/test_elixir.py::test_line_numbers_are_one_based_and_correct` lines 59-62
- `tests/indexing/parsing/lang/test_php.py::test_line_numbers_are_one_based_and_correct` lines 55-58
- `tests/indexing/parsing/lang/test_python.py::test_line_numbers_are_one_based_and_correct` lines 68-71
- `tests/indexing/parsing/lang/test_go.py::test_line_numbers_are_one_based_and_correct` lines 70-73
- `tests/indexing/parsing/lang/test_rust.py::test_line_numbers_are_one_based_and_correct` lines 72-75
- `tests/indexing/parsing/lang/test_kotlin.py::test_line_numbers_are_one_based_and_correct` lines 68-71
- `tests/indexing/parsing/lang/test_csharp.py::test_line_numbers_are_one_based_and_correct` lines 61-64

## HV-008

- `src/slopo/indexing/parsing/lang/csharp.py::_count_named_nodes` lines 108-112
- `src/slopo/indexing/parsing/lang/elixir.py::_count_named_nodes` lines 158-162
- `src/slopo/indexing/parsing/lang/java.py::_count_named_nodes` lines 90-94
- `src/slopo/indexing/parsing/lang/rust.py::_count_named_nodes` lines 90-94
- `src/slopo/indexing/parsing/lang/javascript.py::_count_named_nodes` lines 97-101
- `src/slopo/indexing/parsing/lang/typescript.py::_count_named_nodes` lines 97-101
- `src/slopo/indexing/parsing/lang/kotlin.py::_count_named_nodes` lines 100-104
- `src/slopo/indexing/parsing/lang/go.py::_count_named_nodes` lines 104-108
- `src/slopo/indexing/parsing/lang/php.py::_count_named_nodes` lines 96-100
- `src/slopo/indexing/parsing/lang/python.py::_count_named_nodes` lines 68-74

## HV-009

- `tests/indexing/parsing/lang/test_java.py::test_body_node_count_is_zero_for_abstract_method` lines 83-85
- `tests/indexing/parsing/lang/test_php.py::test_body_node_count_is_zero_for_abstract_method` lines 86-88
- `tests/indexing/parsing/lang/test_kotlin.py::test_body_node_count_is_zero_for_function_without_body` lines 92-94
- `tests/indexing/parsing/lang/test_go.py::test_body_node_count_is_zero_for_function_without_body` lines 85-87
- `tests/indexing/parsing/lang/test_rust.py::test_body_node_count_is_zero_for_signature_without_body` lines 94-96

## HV-010

- `tests/indexing/parsing/lang/fixtures/javascript/Example.js::fetchUser` lines 9-12
- `tests/indexing/parsing/lang/fixtures/typescript/Example.ts::fetchUser` lines 9-12

## HV-011

- `tests/indexing/parsing/lang/test_go.py::body_sizes` lines 22-23
- `tests/indexing/parsing/lang/test_python.py::body_sizes` lines 22-23
- `tests/indexing/parsing/lang/test_php.py::body_sizes` lines 27-28
- `tests/indexing/parsing/lang/test_csharp.py::body_sizes` lines 27-28
- `tests/indexing/parsing/lang/test_typescript.py::body_sizes` lines 27-28
- `tests/indexing/parsing/lang/test_javascript.py::body_sizes` lines 22-23
- `tests/indexing/parsing/lang/test_elixir.py::body_sizes` lines 27-28
- `tests/indexing/parsing/lang/test_rust.py::body_sizes` lines 27-28
- `tests/indexing/parsing/lang/test_java.py::body_sizes` lines 27-28
- `tests/indexing/parsing/lang/test_kotlin.py::body_sizes` lines 27-28

## HV-012

- `tests/indexing/parsing/lang/fixtures/java/Lambdas.java::configure` lines 21-25
- `tests/indexing/parsing/lang/fixtures/kotlin/Lambdas.kt::configure` lines 16-20

## HV-013

- `tests/indexing/parsing/lang/test_javascript.py::test_arrow_function_named_from_binding` lines 47-49
- `tests/indexing/parsing/lang/test_typescript.py::test_arrow_function_named_from_binding` lines 53-55

## HV-014

- `src/slopo/indexing/parsing/lang/csharp.py::_collect_comment_spans` lines 83-88
- `src/slopo/indexing/parsing/lang/elixir.py::_collect_comment_spans` lines 109-114
- `src/slopo/indexing/parsing/lang/java.py::_collect_comment_spans` lines 75-80
- `src/slopo/indexing/parsing/lang/rust.py::_collect_comment_spans` lines 75-80
- `src/slopo/indexing/parsing/lang/javascript.py::_collect_comment_spans` lines 82-87
- `src/slopo/indexing/parsing/lang/typescript.py::_collect_comment_spans` lines 82-87
- `src/slopo/indexing/parsing/lang/kotlin.py::_collect_comment_spans` lines 83-88
- `src/slopo/indexing/parsing/lang/go.py::_collect_comment_spans` lines 89-94
- `src/slopo/indexing/parsing/lang/php.py::_collect_comment_spans` lines 81-86
- `src/slopo/indexing/parsing/lang/python.py::_collect_comment_spans` lines 53-58

## HV-015

- `src/slopo/indexing/parsing/lang/go.py::_count_body_nodes` lines 97-101
- `src/slopo/indexing/parsing/lang/javascript.py::_count_body_nodes` lines 90-94
- `src/slopo/indexing/parsing/lang/rust.py::_count_body_nodes` lines 83-87
- `src/slopo/indexing/parsing/lang/typescript.py::_count_body_nodes` lines 90-94
- `src/slopo/indexing/parsing/lang/php.py::_count_body_nodes` lines 89-93
- `src/slopo/indexing/parsing/lang/csharp.py::_count_body_nodes` lines 91-95
- `src/slopo/indexing/parsing/lang/elixir.py::_count_body_nodes` lines 117-118

## HV-016

- `tests/indexing/parsing/lang/test_csharp.py::test_lambda_bound_to_variable_takes_binding_name` lines 121-123
- `tests/indexing/parsing/lang/test_java.py::test_lambda_bound_to_variable_takes_binding_name` lines 115-117
- `tests/indexing/parsing/lang/test_kotlin.py::test_anonymous_function_bound_to_variable_takes_binding_name` lines 124-126
- `tests/indexing/parsing/lang/test_elixir.py::test_anonymous_function_bound_to_variable_takes_binding_name` lines 121-123
- `tests/indexing/parsing/lang/test_php.py::test_arrow_function_bound_to_variable_takes_binding_name` lines 119-121
- `tests/indexing/parsing/lang/test_go.py::test_closure_bound_to_variable_takes_binding_name` lines 112-114
- `tests/indexing/parsing/lang/test_rust.py::test_closure_bound_to_variable_takes_binding_name` lines 122-124

## HV-017

- `tests/indexing/parsing/lang/fixtures/java/Lambdas.java::transform` lines 10-19
- `tests/indexing/parsing/lang/fixtures/kotlin/Lambdas.kt::transform` lines 6-14
- `tests/indexing/parsing/lang/fixtures/csharp/Lambdas.cs::Transform` lines 8-19

## HV-018

- `tests/indexing/parsing/lang/test_javascript.py::test_strips_line_block_and_doc_comments_from_body` lines 87-96
- `tests/indexing/parsing/lang/test_typescript.py::test_strips_line_block_and_doc_comments_from_body` lines 109-117
- `tests/indexing/parsing/lang/test_rust.py::test_strips_line_block_and_doc_comments_from_body` lines 109-119
- `tests/indexing/parsing/lang/test_java.py::test_strips_line_and_block_comments_from_body` lines 103-112
- `tests/indexing/parsing/lang/test_go.py::test_strips_line_and_block_comments_from_body` lines 100-109
- `tests/indexing/parsing/lang/test_kotlin.py::test_strips_line_block_and_kdoc_comments_from_body` lines 112-121
- `tests/indexing/parsing/lang/test_csharp.py::test_strips_line_block_and_doc_comments_from_body` lines 108-118
- `tests/indexing/parsing/lang/test_php.py::test_strips_every_comment_style_from_body` lines 106-116

## HV-019

- `tests/indexing/parsing/lang/test_javascript.py::test_function_declaration_body_exact` lines 42-44
- `tests/indexing/parsing/lang/test_typescript.py::test_function_declaration_body_exact` lines 46-50
- `tests/indexing/parsing/lang/test_php.py::test_body_exact` lines 45-52
- `tests/indexing/parsing/lang/test_java.py::test_body_exact` lines 45-50
- `tests/indexing/parsing/lang/test_elixir.py::test_body_exact_for_do_block` lines 45-47
- `tests/indexing/parsing/lang/test_go.py::test_switch_function_body_exact` lines 54-67
- `tests/indexing/parsing/lang/test_python.py::test_branching_function_body_exact` lines 46-56
- `tests/indexing/parsing/lang/test_rust.py::test_match_function_body_exact` lines 59-69
- `tests/indexing/parsing/lang/test_kotlin.py::test_when_expression_body_exact` lines 50-58
- `tests/indexing/parsing/lang/test_kotlin.py::test_expression_body_function_body_exact` lines 45-47
- `tests/indexing/parsing/lang/test_python.py::test_fstring_function_body_exact` lines 41-43

## HV-020

- `tests/analysis/test_clustering.py::pair` lines 11-12
- `tests/analysis/test_rerank.py::pair` lines 13-14

## HV-021

- `tests/indexing/parsing/lang/test_csharp.py::test_nested_lambda_emitted_alongside_enclosing_method` lines 148-158
- `tests/indexing/parsing/lang/test_java.py::test_nested_lambda_emitted_alongside_enclosing_method` lines 138-146

## HV-022

- `src/slopo/indexing/parsing/lang/javascript.py::_binding_name_node` lines 53-66
- `src/slopo/indexing/parsing/lang/typescript.py::_binding_name_node` lines 53-66
- `src/slopo/indexing/parsing/lang/java.py::_binding_name_node` lines 48-59
- `src/slopo/indexing/parsing/lang/csharp.py::_binding_name_node` lines 56-67
- `src/slopo/indexing/parsing/lang/php.py::_binding_name_node` lines 53-65
- `src/slopo/indexing/parsing/lang/rust.py::_binding_name_node` lines 48-59
- `src/slopo/indexing/parsing/lang/go.py::_binding_name_node` lines 48-63
- `src/slopo/indexing/parsing/lang/kotlin.py::_binding_name_node` lines 49-61
- `src/slopo/indexing/parsing/lang/elixir.py::_binding_name_node` lines 84-93

## HV-023

- `tests/indexing/parsing/lang/test_elixir.py::closures` lines 37-38
- `tests/indexing/parsing/lang/test_go.py::closures` lines 32-33
- `tests/indexing/parsing/lang/test_rust.py::closures` lines 37-38
- `tests/indexing/parsing/lang/test_php.py::closures` lines 37-38

## HV-024

- `src/slopo/indexing/parsing/lang/go.py::_count_body_nodes` lines 97-101
- `src/slopo/indexing/parsing/lang/javascript.py::_count_body_nodes` lines 90-94
- `src/slopo/indexing/parsing/lang/rust.py::_count_body_nodes` lines 83-87
- `src/slopo/indexing/parsing/lang/typescript.py::_count_body_nodes` lines 90-94
- `src/slopo/indexing/parsing/lang/php.py::_count_body_nodes` lines 89-93
- `src/slopo/indexing/parsing/lang/csharp.py::_count_body_nodes` lines 91-95
- `src/slopo/indexing/parsing/lang/elixir.py::_count_body_nodes` lines 117-118
- `src/slopo/indexing/parsing/lang/python.py::_count_body_nodes` lines 61-65
- `src/slopo/indexing/parsing/lang/kotlin.py::_count_body_nodes` lines 91-97
- `src/slopo/indexing/parsing/lang/java.py::_count_body_nodes` lines 83-87

## HV-025

- `tests/indexing/parsing/lang/test_csharp.py::test_callback_lambda_without_binding_is_unknown` lines 136-145
- `tests/indexing/parsing/lang/test_java.py::test_callback_lambda_without_binding_is_unknown` lines 127-135
- `tests/indexing/parsing/lang/test_kotlin.py::test_callback_anonymous_function_without_binding_is_unknown` lines 134-141
- `tests/indexing/parsing/lang/test_elixir.py::test_callback_anonymous_function_without_binding_is_unknown` lines 126-128
- `tests/indexing/parsing/lang/test_go.py::test_callback_closure_without_binding_is_unknown` lines 122-126
- `tests/indexing/parsing/lang/test_rust.py::test_callback_closure_without_binding_is_unknown` lines 132-137
- `tests/indexing/parsing/lang/test_php.py::test_callback_arrow_function_without_binding_is_unknown` lines 129-131

## HV-026

- `tests/indexing/parsing/lang/fixtures/elixir/Comments.ex::with_comments` lines 2-7
- `tests/indexing/parsing/lang/fixtures/python/Comments.py::with_comments` lines 1-6
- `tests/indexing/parsing/lang/fixtures/rust/Comments.rs::with_comments` lines 3-9
- `tests/indexing/parsing/lang/fixtures/kotlin/Comments.kt::withComments` lines 6-13
- `tests/indexing/parsing/lang/fixtures/java/Comments.java::withComments` lines 6-13
- `tests/indexing/parsing/lang/fixtures/php/Comments.php::withComments` lines 8-15
- `tests/indexing/parsing/lang/fixtures/javascript/Comments.js::withComments` lines 6-13
- `tests/indexing/parsing/lang/fixtures/go/Comments.go::WithComments` lines 5-11

## HV-027

- `src/slopo/indexing/parsing/lang/csharp.py::_body_without_comments` lines 70-80
- `src/slopo/indexing/parsing/lang/elixir.py::_body_without_comments` lines 96-106
- `src/slopo/indexing/parsing/lang/javascript.py::_body_without_comments` lines 69-79
- `src/slopo/indexing/parsing/lang/rust.py::_body_without_comments` lines 62-72
- `src/slopo/indexing/parsing/lang/typescript.py::_body_without_comments` lines 69-79
- `src/slopo/indexing/parsing/lang/go.py::_body_without_comments` lines 76-86
- `src/slopo/indexing/parsing/lang/php.py::_body_without_comments` lines 68-78
- `src/slopo/indexing/parsing/lang/java.py::_body_without_comments` lines 62-72
- `src/slopo/indexing/parsing/lang/python.py::_body_without_comments` lines 40-50
- `src/slopo/indexing/parsing/lang/kotlin.py::_body_without_comments` lines 70-80

## HV-028

- `src/slopo/indexing/parsing/lang/javascript.py::_unit_name` lines 44-50
- `src/slopo/indexing/parsing/lang/typescript.py::_unit_name` lines 44-50
- `src/slopo/indexing/parsing/lang/php.py::_unit_name` lines 43-50
- `src/slopo/indexing/parsing/lang/go.py::_unit_name` lines 38-45
- `src/slopo/indexing/parsing/lang/java.py::_unit_name` lines 38-45
- `src/slopo/indexing/parsing/lang/rust.py::_unit_name` lines 38-45
- `src/slopo/indexing/parsing/lang/csharp.py::_unit_name` lines 46-53
- `src/slopo/indexing/parsing/lang/kotlin.py::_unit_name` lines 38-46
- `src/slopo/indexing/parsing/lang/elixir.py::_unit_name` lines 56-70
