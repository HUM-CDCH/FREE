## 1. Backend guidance strings

- [x] 1.1 Append wrapper-key prohibition to `TEMPLATE_GUIDANCE` in `generate_template.py`
- [x] 1.2 Append the same prohibition to `_TEMPLATE_GENERATION_TASK_INSTRUCTIONS` in `nuextract_request.py`

## 2. Verify

- [x] 2.1 Confirm both strings now end with the wrapper-key constraint sentence
- [x] 2.2 Confirm no other guidance strings in the schema-suggestion path are missing the constraint
