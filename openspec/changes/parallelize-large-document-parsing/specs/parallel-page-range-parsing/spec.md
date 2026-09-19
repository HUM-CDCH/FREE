## ADDED Requirements

### Requirement: Large documents are partitioned by page range

The parsing service SHALL split a document into contiguous page-range
partitions, computed over the prepared page space produced by the existing
scanned-column preparation pass, only when the prepared page count exceeds a
configured `PARALLEL_PARSE_MIN_PAGES` threshold. Documents at or under the
threshold SHALL use the existing single-call conversion path unchanged.

#### Scenario: Document exceeds the partition threshold

- **WHEN** a document's prepared page count is greater than
  `PARALLEL_PARSE_MIN_PAGES`
- **THEN** the service converts it as multiple page-range partitions

#### Scenario: Document is at or under the partition threshold

- **WHEN** a document's prepared page count is less than or equal to
  `PARALLEL_PARSE_MIN_PAGES`
- **THEN** the service converts it with a single `page_range`-free call, as
  it does today

### Requirement: Partition split points avoid detected tables

Before dispatching partitions, the service SHALL check each candidate
even-page-count split point against table bounding boxes detected on the
adjacent pages and SHALL shift a boundary that lands inside a detected table
to the nearest table-free page gap within a bounded search radius. Detected
table geometry used for this check SHALL NOT be published as canonical
content.

#### Scenario: Candidate boundary lands inside a detected table

- **WHEN** a detected table's bounding box straddles a candidate partition
  boundary
- **THEN** the service shifts that boundary to the nearest page gap outside
  any detected table within the search radius

#### Scenario: No clean gap exists within the search radius

- **WHEN** no table-free page gap is found within the search radius of a
  candidate boundary
- **THEN** the service keeps the original boundary and relies on
  merge-time boundary-table handling

### Requirement: Partitions are converted independently and merged

Each partition SHALL be converted, restored to physical-page coordinates,
and published as a self-contained `parsed_document.v2` fragment
independently, using a partition-qualified reference namespace so that
`block_id`, `anchor_id`, `table_id`, `cell_id`, and `occurrence_id` values
stay globally unique across partitions. The service SHALL merge partition
fragments into one `parsed_document.v2` document covering the full physical
page range, and the merged document SHALL satisfy every existing
`parsed-document-v2` validation requirement.

#### Scenario: All partitions succeed

- **WHEN** every partition converts and publishes successfully
- **THEN** the service merges them into one `parsed_document.v2` document
  with complete, contiguous physical-page coverage and no duplicate
  `block_id`, `anchor_id`, `table_id`, `cell_id`, or `occurrence_id` values

#### Scenario: One partition fails

- **WHEN** any partition's conversion raises or reports a non-success status
- **THEN** the whole task fails, matching the existing single-call failure
  behavior, and no partial merged document is published

### Requirement: Boundary tables are stitched when geometry confirms continuation

When a table is split across a partition boundary, the service SHALL stitch
the two Docling-produced table fragments into one logical `table_id` when
their bounding boxes are flush against the boundary, their column counts and
column x-boundaries match within tolerance, and the continuation fragment's
first row is a duplicate of the earlier fragment's header row. A stitched
table SHALL keep the earlier partition's `table_id`, SHALL drop the
duplicated header row from the continuation fragment, and SHALL be marked
`derived_continuation`. When any alignment condition fails, the two tables
SHALL remain separate and SHALL each carry a diagnostic identifying the
unstitched boundary.

#### Scenario: Adjacent tables align geometrically

- **WHEN** the last table on one partition and the first table on the next
  partition are flush against the partition boundary with matching column
  count and aligned column x-boundaries
- **THEN** the service stitches them into one `table_id`, drops the
  continuation fragment's duplicated header row, and marks the result
  `derived_continuation`

#### Scenario: Adjacent tables do not align geometrically

- **WHEN** two tables adjacent to a partition boundary differ in column
  count, column x-boundaries, or are not flush against the boundary
- **THEN** the service publishes them as two separate tables, each carrying
  a diagnostic identifying the unstitched partition boundary

### Requirement: Boundary text content is diagnosed, not stitched

A non-table content block whose provenance falls within a partition boundary
margin SHALL remain a separate published block. The service SHALL attach a
diagnostic marking the boundary so reviewers can identify where a partition
split may have separated related narrative content.

#### Scenario: A paragraph straddles a partition boundary

- **WHEN** a non-table content block's provenance falls within the boundary
  margin of a partition split
- **THEN** the service publishes it as-is and attaches a diagnostic marking
  the partition boundary, without attempting to merge it with adjacent
  content

### Requirement: Worker pool size is bounded

The service SHALL convert partitions using a worker process pool bounded by
a configured `PARALLEL_PARSE_MAX_WORKERS` limit, regardless of how many
partitions a document is split into.

#### Scenario: Partition count exceeds the worker pool size

- **WHEN** a document is split into more partitions than
  `PARALLEL_PARSE_MAX_WORKERS`
- **THEN** the service queues the remaining partitions behind the bounded
  pool instead of starting additional worker processes
