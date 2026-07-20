<!-- markdownlint-disable MD013 -->

# canonical-document-parsing Delta Specification

## ADDED Requirements

### Requirement: Canonical text artifacts are byte-deterministic

Canonical text artifacts (canonical Markdown and other text files whose digests participate in cache identity) SHALL be written as UTF-8 with LF line endings regardless of platform newline defaults, so the same logical content always produces the same content digest.

#### Scenario: Same document parsed on different platforms

- **WHEN** the same Source Document is parsed on hosts with different platform newline defaults
- **THEN** the canonical text artifacts are byte-identical and their content digests match
