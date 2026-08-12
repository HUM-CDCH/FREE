## ADDED Requirements

### Requirement: Catalog discovery uses an exact strict heading-label contract

Catalog discovery SHALL return exactly `{ "starts": string[] }`. Each label SHALL match canonical heading text byte-for-byte at the decoded string boundary, with no case, whitespace, Unicode, marker, or fuzzy normalization. The resolver SHALL reject the entire discovery response when its shape is invalid or a label is unknown, duplicated, text-ambiguous, resolves to a non-heading, or resolves in non-monotonic source order.

#### Scenario: Ordered unique headings resolve

- **WHEN** discovery returns unique exact labels for canonical headings in source order
- **THEN** the resolver returns those canonical headings in source order
- **AND** each record identity is its canonical start block ID

#### Scenario: Invalid discovery is rejected without recovery

- **WHEN** a discovery label is unknown, duplicated, ambiguous, non-heading, or non-monotonic
- **THEN** the complete discovery response is rejected
- **AND** no fuzzy, normalized, or partial recovery is attempted

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
