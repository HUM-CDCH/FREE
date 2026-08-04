<!-- markdownlint-disable MD013 -->

# source-document-ingestion Delta Specification

## ADDED Requirements

### Requirement: Source Document request admission precedes multipart parsing

The parsing service SHALL reject an oversized `POST /tasks` request before FastAPI multipart parsing can spool the body. The request limit SHALL be 51 MiB, comprising an exact 50 MiB Source Document allowance plus a fixed 1 MiB multipart-envelope allowance. The service SHALL retain an exact post-parse 50 MiB source-byte check.

#### Scenario: Declared request exceeds admission limit

- **WHEN** `POST /tasks` has a valid `Content-Length` greater than 51 MiB
- **THEN** the service returns 413 before invoking the route or creating task storage

#### Scenario: Streamed request crosses admission limit

- **WHEN** a request has no usable length declaration or uses chunked transfer
- **AND** cumulative received body bytes exceed 51 MiB
- **THEN** the service returns 413 without buffering or spooling the remaining body as a Source Document

#### Scenario: Source bytes exceed their exact limit

- **WHEN** the total request fits within 51 MiB
- **BUT** the parsed Source Document exceeds 50 MiB
- **THEN** the exact source-byte validator returns 413

### Requirement: URL ingestion permits only confidently public standard web destinations

The parsing service SHALL permit only HTTP port 80 and HTTPS port 443 for the initial Source Document URL and every redirect hop. It SHALL reject credentials, private/non-global addresses, and risky IPv4-embedded or transition IPv6 forms that cannot be confidently treated as public. Every accepted resolved address SHALL remain pinned for the connection.

#### Scenario: URL uses a nonstandard port

- **WHEN** the initial URL or a redirect explicitly resolves to a port other than the scheme's permitted standard port
- **THEN** ingestion rejects the URL before connecting

#### Scenario: Literal private address is supplied

- **WHEN** a URL hostname is a forbidden literal IP address
- **THEN** ingestion rejects it before DNS resolution or socket connection

#### Scenario: Redirect resolves to an internal address

- **WHEN** an otherwise public URL redirects to a hostname whose resolved address is private or internal
- **THEN** the redirect is rejected and no connection is made to that destination

#### Scenario: Risky IPv6 transition form is supplied

- **WHEN** an IPv6 literal or resolution embeds a non-global IPv4 destination or uses a transition form the service cannot confidently classify as public
- **THEN** ingestion rejects the address

### Requirement: URL response limits are enforced while streaming

URL ingestion SHALL enforce redirect count, total deadline, declared byte size, streamed byte size, PDF magic, and allowed response media types without trusting headers alone.

#### Scenario: Redirect response lacks a destination

- **WHEN** a redirect response has no valid `Location`
- **THEN** ingestion fails with a stable client-safe error

#### Scenario: Stream exceeds the byte limit

- **WHEN** response headers do not declare an excessive size
- **BUT** streamed bytes exceed the configured download limit
- **THEN** ingestion stops reading, removes temporary content, and returns the size error

### Requirement: Ingestion failures do not disclose service storage details

The parsing service SHALL classify ingestion failures without returning raw exception text or absolute paths.

#### Scenario: Source content is invalid

- **WHEN** extension, media type, or PDF magic validation fails
- **THEN** the service returns a generic 400 response identifying the invalid Source Document condition

#### Scenario: Source admission exceeds a byte limit

- **WHEN** the request or exact Source Document byte limit is exceeded
- **THEN** the service returns 413

#### Scenario: Storage capacity is exhausted

- **WHEN** disk or quota capacity prevents source persistence
- **THEN** the service returns a generic 507 response
- **AND** no internal path or raw `OSError` text appears in the response

#### Scenario: Unexpected filesystem operation fails

- **WHEN** a non-capacity filesystem error prevents ingestion
- **THEN** the service returns a generic 500 response and logs internal detail server-side
