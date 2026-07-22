## MODIFIED Requirements

### Requirement: Chat instruction produces an op list, not a replacement schema

When the researcher types an instruction in the schema chat, the system SHALL call `/api/edit_schema` and receive a structured list of field operations. The system SHALL NOT call `/api/generate_schema` for chat-initiated edits.

For every field currently present in the schema, the system SHALL obtain a result for that field from its own dedicated model call — completeness is guaranteed by the system issuing one such call per field, not by trusting a single response to enumerate every affected field correctly. Requests for entirely new fields (`add` operations) remain a separate, unconstrained list, since they cannot be enumerated against the existing schema in advance.

To bound latency, the system SHALL run the per-field calls concurrently (capped, not unbounded) rather than sequentially, and SHALL retry an individual field's call independently on failure rather than retrying or discarding a larger group of fields.

#### Scenario: Researcher adds a field via chat

- **WHEN** the researcher types "add a field for excavation date"
- **THEN** the system calls `POST /api/edit_schema` with the current template JSON and the instruction
- **AND** the model returns an op list such as `[{"op":"add","name":"excavation_date","type":"date","parentName":null}]`
- **AND** only that field is added to the schema; all other fields are unchanged

#### Scenario: Model returns empty op list

- **WHEN** the model determines no change is needed
- **THEN** the model returns `[]`
- **AND** the system shows "No changes needed" in the chat without modifying the schema

#### Scenario: Model returns malformed JSON

- **WHEN** the model response cannot be parsed as a JSON array
- **THEN** the system shows an error message in the chat
- **AND** the schema is not modified

#### Scenario: Broad instruction covers every existing field

- **WHEN** the researcher types an instruction that applies to all or most fields (e.g. "translate all field names to Danish") on a schema with nested fields
- **THEN** the system's response accounts for every field currently in the schema, including nested ones
- **AND** the resulting op list, once applied, changes every field the instruction applies to — none are silently left unchanged because the model forgot to mention them

#### Scenario: Existing fields are each requested individually and concurrently

- **WHEN** the schema being edited has more than one field
- **THEN** the system issues one model call per existing field, run concurrently up to a bounded limit rather than all at once or one at a time
- **AND** the per-field results are combined into a single op list before being returned

#### Scenario: A single field's response fails validation

- **WHEN** a model's response for one field does not match the required `{ name, type, removed }` structure
- **THEN** the system retries that field's call a small, bounded number of times before giving up
- **AND** if it still fails, the system surfaces an error rather than silently omitting that field or applying a partial result
- **AND** other fields' results are unaffected by one field's failure
