# Extraction ablation study

## Purpose

An executable study produces reproducible controlled comparisons of extraction techniques
with pinned inputs, complete result accounting and explicit evaluation limitations.

## ADDED Requirements

### Requirement: A study freezes its comparisons and inputs
A study SHALL pin source, schema, code, method, model and scoring identities before execution.
A declared one-factor comparison SHALL change exactly that factor; differing nuisance
variables SHALL be rejected or classified as a whole-system comparison.

#### Scenario: An arm also changes its schema
- **WHEN** an overlap-only comparison supplies a different schema
- **THEN** the study refuses to classify it as an overlap ablation

### Requirement: Captures and completion are auditable
Each study cell SHALL record exact sanitized requests/replies, terminal status, elapsed costs
and input identity. Failures and refusals SHALL remain visible in the final matrix.

#### Scenario: A model reply is truncated
- **WHEN** a model ends a reply at its length limit
- **THEN** the cell records the incomplete outcome without presenting it as successful extraction

### Requirement: Resumption does not create false replication
The runner SHALL reuse only completed cells whose pins match exactly. It SHALL distinguish
reused output from fresh inference and exclude replay timings from fresh performance claims.

#### Scenario: Code changes before resumption
- **WHEN** the current code identity differs from the frozen study
- **THEN** the runner refuses silent resumption under the same study identity

### Requirement: Evaluation accounts for omissions and extra predictions
The report SHALL include record and observation accounting alongside field scores. It SHALL
identify unscored predictions when gold is incomplete and SHALL NOT treat source links as
independent proof of semantic correctness.

#### Scenario: A correct projected observation hides an extra wrong one
- **WHEN** a record contains the expected observation plus additional observations
- **THEN** those additional observations remain visible outside the projected field score

### Requirement: Statistical and data scope remain explicit
The report SHALL state corpus exposure, document counts, paired effects and uncertainty at
the document level. It SHALL distinguish development results, held-out results, deterministic
fixtures and fresh live-model repetitions.

#### Scenario: Previously inspected papers are split into partitions
- **WHEN** previously used development documents are partitioned for a new experiment
- **THEN** the report does not describe them as previously unseen test data
