## Purpose

Durable Extraction Jobs preserve owned Extraction intent and intermediate values across requests, navigation, process loss, cancellation, and Batch Extraction execution.

## ADDED Requirements

### Requirement: Interactive Extraction scheduling is durable and idempotent

An interactive Extraction request SHALL durably record its owned normalized inputs before model work and SHALL return without waiting for execution. Reusing an owned identity with equal inputs SHALL replay the job or terminal Extraction; unequal inputs SHALL conflict, and foreign identities SHALL remain undisclosed.

Only Extractions backed by an Extraction Job are readable, reviewable, reopenable, or retryable. FREE SHALL NOT synthesize job state for pre-job rows.

#### Scenario: New interactive Extraction is scheduled

- **WHEN** a researcher posts a valid new interactive Extraction identity
- **THEN** FREE returns a queued attempt and can execute it after the request ends

#### Scenario: Extraction identity is replayed

- **WHEN** the researcher posts the same identity with the same normalized pins and retry selection
- **THEN** FREE returns the existing job or terminal Extraction without scheduling duplicate work

#### Scenario: Pre-job state exists

- **WHEN** stored Extraction or Batch Extraction state has no Extraction Job identity
- **THEN** FREE does not expose or rewrite it, and migration fails before changing incompatible Batch Extraction data

### Requirement: Values are checkpointed before Evidence linking

FREE SHALL durably checkpoint extracted values before Evidence linking starts. A reclaimed job with a checkpoint SHALL resume Evidence linking without repeating value extraction.

#### Scenario: Worker loses its lease after values complete

- **WHEN** another worker reclaims a running job whose values checkpoint is durable
- **THEN** the new worker starts Evidence linking from that checkpoint without another value-model call

### Requirement: Job failures retain non-authoritative values

A failed or cancelled new job SHALL create no Extraction and SHALL retain any checkpointed values for display without Evidence, review, or export authority.

#### Scenario: Evidence linking fails after values extraction

- **WHEN** values are checkpointed and Evidence linking fails
- **THEN** the job becomes failed, the values remain readable, and no reviewable Extraction exists

### Requirement: Extraction Job execution is leased and recoverable

FREE SHALL claim queued jobs with expiring leases, renew active leases, reclaim expired work, and discover queued or reclaimable work without relying solely on an in-process wake signal.

#### Scenario: Worker process disappears

- **WHEN** a running job's lease expires after its worker disappears
- **THEN** another Studio process discovers and reclaims the job without a new scheduling request

### Requirement: Interactive work has queue priority

Each Studio process SHALL execute at most one Extraction Job at a time and SHALL claim interactive jobs before Batch Extraction member jobs, preserving FIFO order within each kind.

#### Scenario: Interactive and batch jobs are queued

- **WHEN** both kinds are claimable
- **THEN** the worker claims the oldest interactive job first

### Requirement: Batch members use Extraction Jobs without exposing previews

Opening a Batch Extraction SHALL durably create one initial Batch Extraction member job per selected Source Document. Batch progress SHALL reflect those jobs, while provisional member values SHALL remain absent from Batch Extraction responses.

#### Scenario: Batch member checkpoints values

- **WHEN** a Batch Extraction member job reaches its values checkpoint
- **THEN** batch reads still report execution progress without returning provisional member values
