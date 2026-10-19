# Slopo blind-validation review queue

Frozen configuration SHA-256: `db8b82f0e1bcf1334fcdb05df6e5c3ce60bc066b3ca6b0ba8362458c0767953c`

Queue SHA-256: `21d8e20a40ffbc3e7a46571868ac838b518b250f146ee037ba513a97364a84b7`

Review the candidates in this shuffled order. Model identity, support, rank, and similarity scores are intentionally hidden. Mark a candidate positive only when all reported members form one coherent duplicate implementation or refactoring opportunity.

## HV-001

- `fastapi/param_functions.py::Path` lines 13-354
- `fastapi/param_functions.py::File` lines 1968-2280
- `fastapi/param_functions.py::Cookie` lines 1018-1320
- `fastapi/param_functions.py::Form` lines 1653-1965
- `fastapi/param_functions.py::Body` lines 1323-1650
- `fastapi/param_functions.py::Header` lines 701-1015

## HV-002

- `fastapi/security/api_key.py::__call__` lines 142-144
- `fastapi/security/api_key.py::__call__` lines 230-232
- `fastapi/security/api_key.py::__call__` lines 318-320

## HV-003

- `fastapi/applications.py::add_api_websocket_route` lines 1355-1368
- `fastapi/routing.py::add_api_websocket_route` lines 2986-3006
- `fastapi/routing.py::add_websocket_route` lines 2578-2585

## HV-004

- `fastapi/routing.py::handle` lines 1764-1766
- `fastapi/routing.py::handle` lines 2734-2742
- `fastapi/routing.py::handle` lines 2057-2058
- `fastapi/routing.py::_handle_selected` lines 1768-1788

## HV-005

- `fastapi/applications.py::frontend` lines 1222-1293
- `fastapi/routing.py::frontend` lines 2587-2668

## HV-006

- `fastapi/dependencies/models.py::is_gen_callable` lines 106-129
- `fastapi/dependencies/models.py::is_async_gen_callable` lines 132-155

## HV-007

- `fastapi/security/oauth2.py::__call__` lines 423-430
- `fastapi/security/open_id_connect_url.py::__call__` lines 87-94
- `fastapi/security/oauth2.py::__call__` lines 536-544
- `fastapi/security/oauth2.py::__call__` lines 642-650

## HV-008

- `fastapi/exceptions.py::__init__` lines 213-221
- `fastapi/exceptions.py::__init__` lines 235-243
- `fastapi/exceptions.py::__init__` lines 225-231
- `fastapi/exceptions.py::__init__` lines 175-188

## HV-009

- `fastapi/security/http.py::__call__` lines 94-102
- `fastapi/security/http.py::__call__` lines 404-417
- `fastapi/security/http.py::__call__` lines 303-316

## HV-010

- `fastapi/applications.py::include_router` lines 1435-1638
- `fastapi/routing.py::include_router` lines 3084-3271

## HV-011

- `fastapi/dependencies/utils.py::get_validation_alias` lines 1059-1061
- `fastapi/_compat/v2.py::validation_alias` lines 126-130

## HV-012

- `fastapi/security/http.py::__init__` lines 140-195
- `fastapi/security/http.py::__init__` lines 357-402
- `fastapi/security/http.py::__init__` lines 254-301
- `fastapi/security/oauth2.py::__init__` lines 343-399
- `fastapi/security/oauth2.py::__init__` lines 553-640
- `fastapi/security/oauth2.py::__init__` lines 442-534
- `fastapi/security/api_key.py::__init__` lines 14-29
- `fastapi/security/http.py::__init__` lines 72-82
- `fastapi/security/api_key.py::__init__` lines 87-140
- `fastapi/security/api_key.py::__init__` lines 267-316
- `fastapi/security/api_key.py::__init__` lines 179-228
- `fastapi/security/open_id_connect_url.py::__init__` lines 22-78

## HV-013

- `fastapi/routing.py::matches` lines 818-822
- `fastapi/routing.py::matches` lines 2744-2752
- `fastapi/routing.py::matches` lines 1237-1245
- `fastapi/routing.py::matches` lines 2101-2103
- `fastapi/routing.py::matches_with_prefix` lines 2105-2107
- `fastapi/routing.py::_match_low_priority` lines 2762-2810
- `fastapi/routing.py::_match` lines 1714-1748
- `fastapi/routing.py::matches` lines 1491-1512
- `fastapi/routing.py::matches_with_path` lines 2031-2045
- `fastapi/routing.py::matches` lines 2028-2029
- `fastapi/routing.py::matches` lines 1750-1762
- `fastapi/routing.py::_match` lines 2109-2130

## HV-014

- `fastapi/_compat/shared.py::is_pydantic_v1_model_instance` lines 178-187
- `fastapi/_compat/shared.py::is_pydantic_v1_model_class` lines 190-199

## HV-015

- `fastapi/security/http.py::__call__` lines 94-102
- `fastapi/security/http.py::__call__` lines 404-417
- `fastapi/security/http.py::__call__` lines 303-316
- `fastapi/security/http.py::__call__` lines 202-219
- `fastapi/security/open_id_connect_url.py::__call__` lines 87-94
- `fastapi/security/oauth2.py::__call__` lines 423-430
- `fastapi/security/oauth2.py::__call__` lines 536-544
- `fastapi/security/oauth2.py::__call__` lines 642-650

## HV-016

- `fastapi/params.py::__repr__` lines 133-134
- `fastapi/params.py::__repr__` lines 577-578

## HV-017

- `fastapi/applications.py::decorator` lines 1424-1431
- `fastapi/applications.py::decorator` lines 4642-4644
- `fastapi/routing.py::decorator` lines 3078-3080
- `fastapi/routing.py::decorator` lines 3067-3071
- `fastapi/routing.py::websocket_route` lines 3075-3082
- `fastapi/applications.py::websocket_route` lines 4639-4646
- `fastapi/applications.py::websocket` lines 1370-1433
- `fastapi/routing.py::websocket` lines 3008-3073

## HV-018

- `fastapi/routing.py::matches` lines 818-822
- `fastapi/routing.py::matches` lines 2744-2752
- `fastapi/routing.py::matches` lines 1750-1762
- `fastapi/routing.py::matches` lines 1237-1245
- `fastapi/routing.py::_match` lines 1714-1748
- `fastapi/routing.py::_match` lines 2109-2130
- `fastapi/routing.py::matches` lines 1491-1512
- `fastapi/routing.py::matches_with_path` lines 2031-2045
- `fastapi/routing.py::matches` lines 2028-2029
- `fastapi/routing.py::matches` lines 2101-2103
- `fastapi/routing.py::matches_with_prefix` lines 2105-2107

## HV-019

- `fastapi/_compat/v2.py::get_flat_models_from_model` lines 437-443
- `fastapi/_compat/v2.py::get_flat_models_from_fields` lines 478-483
- `fastapi/_compat/v2.py::get_flat_models_from_field` lines 462-475

## HV-020

- `fastapi/utils.py::generate_operation_id_for_path` lines 80-92
- `fastapi/openapi/utils.py::generate_operation_id` lines 215-227

## HV-021

- `fastapi/security/oauth2.py::__init__` lines 59-159
- `fastapi/security/oauth2.py::__init__` lines 226-327

## HV-022

- `fastapi/routing.py::effective_candidates` lines 1587-1610
- `fastapi/routing.py::effective_route_contexts` lines 1790-1795
- `fastapi/routing.py::effective_low_priority_routes` lines 1612-1637

## HV-023

- `fastapi/security/oauth2.py::make_not_authenticated_error` lines 401-421
- `fastapi/security/open_id_connect_url.py::make_not_authenticated_error` lines 80-85
- `fastapi/security/http.py::make_not_authenticated_error` lines 87-92
- `fastapi/security/api_key.py::make_not_authenticated_error` lines 31-45

## HV-024

- `fastapi/openapi/models.py::validate` lines 29-34
- `fastapi/openapi/models.py::_validate` lines 37-42

## HV-025

- `fastapi/params.py::__init__` lines 29-131
- `fastapi/params.py::__init__` lines 470-575
- `fastapi/params.py::__init__` lines 664-742
- `fastapi/params.py::__init__` lines 224-300
- `fastapi/params.py::__init__` lines 582-660
- `fastapi/params.py::__init__` lines 390-466
- `fastapi/params.py::__init__` lines 306-384
- `fastapi/params.py::__init__` lines 140-218

## HV-026

- `fastapi/_compat/v2.py::serialize` lines 190-213
- `fastapi/_compat/v2.py::serialize_json` lines 215-239

## HV-027

- `fastapi/applications.py::on_event` lines 4656-4675
- `fastapi/routing.py::on_event` lines 6374-6398
- `fastapi/routing.py::add_event_handler` lines 6347-6364

## HV-028

- `fastapi/datastructures.py::__get_pydantic_json_schema__` lines 139-142
- `fastapi/openapi/models.py::__get_pydantic_json_schema__` lines 45-48

## HV-029

- `fastapi/applications.py::api_route` lines 1295-1353
- `fastapi/routing.py::api_route` lines 2924-2984
- `fastapi/applications.py::decorator` lines 1324-1351
- `fastapi/routing.py::decorator` lines 2954-2982
- `fastapi/routing.py::decorator` lines 2828-2836
- `fastapi/applications.py::add_api_route` lines 1165-1220
- `fastapi/routing.py::add_api_route` lines 2840-2922
