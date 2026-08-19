## Purpose

Provide a minimal local account and browser-session boundary so a known group of Humanities Researchers can use a private FREE deployment without public registration or an external identity provider.

## ADDED Requirements

### Requirement: Deployment operators manage local Researcher Accounts

FREE SHALL provide deployment CLI operations to create, disable, and reset a Researcher Account identified by a case-insensitive unique email address. Creation and reset SHALL accept a password without exposing it in process arguments, store only a salted one-way password representation, mark the password for mandatory change, and invalidate previously issued sessions. FREE SHALL provide no public registration, invitation flow, account-management UI, role model, or self-service recovery flow.

#### Scenario: Operator creates a Researcher Account

- **WHEN** the operator supplies a previously unused email address and temporary password through the account CLI
- **THEN** FREE creates one Researcher Account with a normalized email and one-way password representation
- **AND** the account must change its password before accessing research or model operations

#### Scenario: Duplicate email differs only by case

- **WHEN** the operator tries to create an account whose normalized email matches an existing account
- **THEN** FREE rejects the command without changing either account

#### Scenario: Operator resets a password

- **WHEN** the operator assigns an existing account a new temporary password
- **THEN** FREE replaces the stored password representation, requires a password change, and invalidates every previously issued session for that account

#### Scenario: Operator disables an account

- **WHEN** the operator disables an existing Researcher Account
- **THEN** FREE invalidates its sessions and rejects subsequent login attempts
- **AND** the account's Project Contexts and descendants remain durable

### Requirement: Password login establishes a bounded signed session

FREE SHALL authenticate an active Researcher Account with its normalized email and password and issue a signed, non-encrypted browser cookie containing no credential or research content. The cookie SHALL be `Secure`, `HttpOnly`, `SameSite=Strict`, and limited to FREE's root path. A session SHALL expire after 12 hours without renewal and no later than 7 days after its original login. Every authenticated request SHALL resolve the account server-side and reject an expired, tampered, disabled, or superseded session.

#### Scenario: Active researcher logs in

- **WHEN** an active Researcher Account submits valid credentials from the configured Studio origin
- **THEN** FREE returns a signed session cookie with the required security attributes and bounded expiry

#### Scenario: Login credentials are invalid

- **WHEN** a login supplies an unknown email, wrong password, or disabled account
- **THEN** FREE returns the same generic authentication failure without revealing which condition occurred

#### Scenario: Session version is superseded

- **WHEN** an account's password is reset or the account is disabled after a cookie was issued
- **THEN** the next request using that cookie is unauthenticated

#### Scenario: Researcher logs out

- **WHEN** an authenticated researcher logs out
- **THEN** FREE clears the browser session cookie
- **AND** subsequent requests from that browser are unauthenticated unless a new login succeeds

### Requirement: Temporary passwords gate normal Studio access

An authenticated account marked for mandatory password change SHALL be allowed to inspect its session, change its own password, and log out, but SHALL NOT access other Studio pages or APIs. A successful password change SHALL store a new one-way representation, clear the mandatory-change state, invalidate the temporary session, and require a new normal session.

#### Scenario: Temporary account opens a project URL

- **WHEN** a Researcher Account with a mandatory password change requests a project page or project API
- **THEN** FREE refuses the operation and directs the browser to the password-change surface

#### Scenario: Researcher changes the temporary password

- **WHEN** the account submits its current temporary password and an acceptable replacement
- **THEN** FREE stores the replacement, clears the mandatory-change state, invalidates prior cookies, and permits a subsequent normal login

### Requirement: Studio denies unauthenticated access by default

Studio SHALL allow unauthenticated access only to the login surface and its static assets, the login/session endpoints needed to establish or inspect authentication, and a shallow `GET /api/healthz` response. Every other Studio API SHALL return an unauthenticated JSON response, and every other Studio document navigation SHALL direct the browser to login before mounting or loading the project application. Browser authentication SHALL NOT be propagated to the internal Parsing Service.

#### Scenario: Unauthenticated API request reaches a protected route

- **WHEN** a browser without a valid session requests any Studio API other than the explicit public authentication or health endpoints
- **THEN** Studio returns HTTP 401 as JSON and does not invoke the protected handler

#### Scenario: Unauthenticated browser opens a project URL

- **WHEN** a browser without a valid session navigates to a Studio project URL
- **THEN** Studio presents the login flow before loading Project Context data
- **AND** a successful login may return the browser only to a validated local Studio path

#### Scenario: Health is checked without a session

- **WHEN** deployment infrastructure calls `GET /api/healthz` without a session
- **THEN** Studio returns only its shallow health result without account, database, model, or research details

### Requirement: Cookie-authenticated mutations are same-origin

FREE SHALL reject unsafe-method requests whose `Origin` does not exactly match the configured canonical Studio origin, including login and logout requests. FREE SHALL apply a bounded in-memory failure limiter before expensive password verification and SHALL remain correct when that limiter is cleared by a process restart.

#### Scenario: Cross-origin request carries a valid cookie

- **WHEN** an unsafe request presents a valid session cookie with a missing or mismatched required origin
- **THEN** FREE rejects the request before invoking its route handler

#### Scenario: Login failures exceed the local limit

- **WHEN** repeated failures for a login identifier or client address exceed the configured in-process bound
- **THEN** FREE temporarily rejects additional attempts with a retry indication
- **AND** it does not reveal whether the Researcher Account exists
