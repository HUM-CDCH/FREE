# Modular extraction experiments

## Purpose

Researchers can compare named extraction techniques over the same canonical source while
retaining understandable stage behavior, bounded inputs and attributable evidence.

## ADDED Requirements

### Requirement: Effective techniques are explicit and reproducible
An extraction SHALL validate its technique settings and record them in its result identity.
Unsupported combinations SHALL fail before inference. The complete-source reference SHALL
remain runnable without silently changing into a bounded variant.

#### Scenario: A grounding policy changes
- **WHEN** otherwise identical requests choose different grounding policies
- **THEN** their fingerprints differ and each result records its effective policy

### Requirement: Bounded execution accounts for source coverage
A bounded method SHALL count rendered requests with the serving tokenizer, reserve output,
and record primary ownership and context selection. It SHALL report any unprocessed or
irreducibly oversized source unit rather than silently truncate it.

#### Scenario: A late table exceeds a request budget
- **WHEN** the next source table does not fit the configured request
- **THEN** it is processed in a source-preserving bounded unit or explicitly refused

### Requirement: Partial identity equality does not establish entity equality
Conservative reconciliation SHALL retain distinct provisional records unless supported
identity information establishes they refer to the same entity. Conflicts SHALL be visible.

#### Scenario: Two people share a name
- **WHEN** two inventory items have the same name but distinct contextual identities
- **THEN** they remain separately extractable and do not collapse solely on that name

### Requirement: Experimental grounding retains truth boundaries
Results SHALL distinguish raw candidates, source evidence and verification status. Disabling
verification SHALL NOT fabricate evidence or represent an unverified value as verified.
Processing, source accounting and measured recall SHALL remain distinct.

#### Scenario: Inventory omits a record
- **WHEN** every returned value is grounded but record recall has not been measured
- **THEN** the result reports recall as unmeasured rather than inferred from successful calls

### Requirement: Catalog factors are independently controlled
Recipe-based Catalog SHALL expose registered context factors independently and preserve
primary source ownership when neighboring context, glossary or heading use changes.

#### Scenario: Neighbor overlap is disabled
- **WHEN** an experiment removes neighboring context
- **THEN** entry ownership and canonical evidence references remain unchanged
