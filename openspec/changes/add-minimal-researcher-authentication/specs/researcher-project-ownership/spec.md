## Purpose

Make each Project Context and its complete research aggregate private to exactly one authenticated Humanities Researcher while retaining shared physical infrastructure and internal job processing.

## ADDED Requirements

### Requirement: Each Project Context has exactly one Researcher Account owner

Every Project Context SHALL reference one existing Researcher Account as its required owner. FREE SHALL derive that owner from the authenticated request when creating a Project Context, and SHALL NOT accept an owner identifier from the browser. Project Contexts SHALL have no membership, sharing, workspace, or role association.

#### Scenario: Researcher creates a Project Context

- **WHEN** an authenticated researcher creates a Project Context
- **THEN** FREE persists the caller's Researcher Account as its non-null owner
- **AND** the request cannot assign it to another account

#### Scenario: Researcher lists Project Contexts

- **WHEN** an authenticated researcher requests the Project Context list
- **THEN** FREE returns only Project Contexts owned by that Researcher Account

### Requirement: Project-owned operations prove root ownership

Every request-facing read or mutation involving a Project Context or descendant resource SHALL include the authenticated Researcher Account in its database authorization condition. This includes project details and lifecycle, Source Documents and representations, annotations, schemas and revisions, extraction and batch operations, results and reviews, reopen flows, and artifact descriptors. Browser-supplied identifiers SHALL identify a candidate resource but SHALL NOT establish authority.

#### Scenario: Researcher uses another account's Project Context ID

- **WHEN** an authenticated researcher requests, renames, or deletes a Project Context owned by another account
- **THEN** FREE returns the same not-found result used for an unknown identifier
- **AND** it does not reveal that the Project Context exists

#### Scenario: Researcher uses another account's descendant ID

- **WHEN** an authenticated researcher addresses a source representation, annotation, schema, revision, extraction, result, batch, review, reopen operation, or artifact through an identifier owned by another account
- **THEN** FREE returns not found without reading, mutating, executing, or disclosing that resource

#### Scenario: Operation combines identifiers from different owners

- **WHEN** a request combines a caller-owned Project Context with any descendant or pin owned by another account
- **THEN** FREE rejects the complete operation as not found and performs no partial mutation

### Requirement: Ownership is inherited through the Project Context aggregate

Descendant records SHALL inherit authorization through their required relationship to the owning Project Context. FREE SHALL NOT duplicate Researcher Account ownership columns across descendants or add sharing access-control rows. Existing aggregate cascade and cleanup behavior SHALL continue within the authorized Project Context.

#### Scenario: Descendant authorization follows its root

- **WHEN** a request addresses a descendant whose relationship chain reaches a Project Context owned by the caller
- **THEN** FREE authorizes it using that root ownership without requiring a duplicate account field on the descendant

#### Scenario: Owned Project Context is deleted

- **WHEN** a researcher deletes their own Project Context
- **THEN** FREE applies the existing aggregate deletion and artifact-candidate cleanup behavior only to that authorized Project Context

### Requirement: Physical artifacts may remain shared without shared access

FREE MAY retain one deployment-wide content-addressed artifact store, but SHALL return or stream an artifact only after an account-scoped database relationship proves access through an owned Project Context. Cleanup SHALL retain a physical package while any Project Context still references it, regardless of owner.

#### Scenario: Two researchers reference identical physical content

- **WHEN** Project Contexts owned by different accounts reference the same content-addressed package
- **THEN** each researcher may access it only through their own authorized database relationship
- **AND** neither researcher can discover the other's Project Context or identifiers

#### Scenario: One reference to shared content is deleted

- **WHEN** one researcher's last reference to a package is deleted while another researcher's reference remains
- **THEN** FREE retains the physical package for the remaining reference

### Requirement: Internal workers use an explicit system scope

Trusted internal workers MAY claim and process durable operations across Researcher Accounts without a browser identity. Those system-scoped operations SHALL be exposed through an internal worker boundary that request-facing handlers cannot use, and the claimed operation and lease SHALL bound subsequent processing.

#### Scenario: Worker claims queued work across accounts

- **WHEN** the internal worker claims the next eligible durable operation
- **THEN** it may process work belonging to any Researcher Account through the internal worker boundary
- **AND** no equivalent unscoped operation is available to an HTTP handler
