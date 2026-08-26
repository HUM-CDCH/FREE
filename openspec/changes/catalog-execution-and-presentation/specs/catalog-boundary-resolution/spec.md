## ADDED Requirements

### Requirement: Catalog discovery uses an exact strict heading-ID contract

Catalog discovery SHALL return exactly `{ "starts": string[] }`. Before the discovery call, the server SHALL mark every canonical heading with one unique, document-local short ID such as `H1`. Each returned ID SHALL match one marked heading ID byte-for-byte, with no case, whitespace, Unicode, marker, or fuzzy normalization. The server SHALL reject the entire discovery response when its shape is invalid or an ID is unknown, duplicated, or resolves in non-monotonic source order. The short IDs and markers SHALL remain model-call-local; each resolved record identity SHALL be its canonical start block ID.

#### Scenario: Ordered unique heading IDs resolve

- **WHEN** discovery returns unique exact IDs for marked canonical headings in source order
- **THEN** the server maps those IDs to canonical headings in source order
- **AND** each record identity is its canonical start block ID

#### Scenario: Invalid discovery is rejected without recovery

- **WHEN** a discovery ID is unknown, duplicated, or non-monotonic
- **THEN** the complete discovery response is rejected
- **AND** no fuzzy, normalized, text-based, or partial recovery is attempted

#### Scenario: Canonical start validation remains strict

- **WHEN** a mapped canonical start block ID is unknown, duplicated, identifies a non-heading, or is non-monotonic
- **THEN** the complete discovery response is rejected
- **AND** no inferred boundary is produced

### Requirement: Canonical headings determine end-exclusive record slices

A resolved boundary SHALL contain the canonical start block ID, inclusive start content-stream index, and exclusive end content-stream index. Heading text and level MAY be retained as diagnostic display data but SHALL NOT define identity. A non-terminal record SHALL end immediately before the next selected start. The terminal record SHALL end immediately before the next later heading at the same or shallower level, or at canonical document end when no such heading exists. Contradictory canonical ordering SHALL be diagnosed rather than guessed.

#### Scenario: Selected next start closes a record

- **WHEN** two selected canonical starts resolve in order
- **THEN** the first record's exclusive end is the second start's content-stream index

#### Scenario: Later peer closes the terminal record

- **WHEN** the terminal selected heading is followed by nested headings and then a heading at the same or shallower level
- **THEN** its exclusive end is the later same-or-shallower heading's index

#### Scenario: Document end closes the terminal record

- **WHEN** no later same-or-shallower heading exists
- **THEN** canonical document end is the terminal record's exclusive end
