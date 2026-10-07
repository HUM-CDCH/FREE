# Microsoft Entra authentication runbook

FREE uses one single-tenant Microsoft Entra application registration. Entra
enterprise-application assignment is the authorization source; FREE keeps only
a local `(tenantId, objectId)` Researcher Account for ownership. It does not use
Microsoft Graph, groups, app roles, refresh tokens, or a local disable list.

## Register the application

1. Create a single-tenant web application registration and require assignment
   on its enterprise application.
2. Register the exact web redirect and post-logout URIs,
   `<STUDIO_ORIGIN><STUDIO_BASE_PATH>/auth/callback` and
   `<STUDIO_ORIGIN><STUDIO_BASE_PATH>/auth/signed-out`. For local real-Entra
   development (`pnpm dev -- --entra`) these are
   `https://localhost:8443/free/auth/callback` and
   `https://localhost:8443/free/auth/signed-out`.
3. Keep only the OIDC `openid` and `profile` delegated permissions. Do not add
   Graph data permissions, group claims, app roles, or an implicit/hybrid
   flow. These scopes are not intrinsically admin-restricted, so FREE does not
   require a tenant-wide grant when the tenant permits user consent. The
   tenant's effective consent policy remains authoritative: if an assigned
   Researcher's smoke login shows an admin-approval error, ask a tenant administrator
   to consent to only `openid` and `profile`; do not broaden permissions or
   disable assignment.
4. Upload the public certificate under **Certificates & secrets**. Store the
   matching private-key PEM outside the repository and mount it read-only into
   Studio.
5. Assign the intended Researchers to the enterprise application. An
   unassigned identity must be denied by Entra before FREE creates a local
   account.

The deployment environment is documented in the root `.env.example`. The
certificate thumbprint is the 64-hex-character SHA-256 fingerprint; colons are
accepted. Validate the key and certificate before deployment:

```bash
openssl x509 -in entra-client.crt -pubkey -noout \
  | openssl pkey -pubin -outform DER | openssl sha256
openssl pkey -in entra-client.pem -pubout -outform DER | openssl sha256
openssl x509 -in entra-client.crt -noout -fingerprint -sha256 -checkend 0
```

The two public-key digests must match.

## Validate the deployment

Check all of the following through the canonical HTTPS URL and configured base
path:

- an assigned Researcher can sign in and a protected `/projects` deep link
  returns to the same local path;
- an unassigned Researcher is denied and no local account is created;
- a session-expiry redirect returns through Entra and restores only a supported
  same-account, same-resource draft;
- logout clears the FREE session and recovery data and visits the tenant logout
  endpoint; because FREE retains no logout hint, Entra may ask the Researcher
  to select an account before redirecting to the public `/auth/signed-out`
  page;
- the browser back button cannot reopen protected UI after logout;
- the exact `/free/auth/callback` and `/free/auth/signed-out` URIs work on the
  development Entra overlay or their hosted equivalents.

Server-acknowledged state always wins over recovery. FREE deliberately accepts
loss of arbitrary component-local text across the reauthentication redirect.

## Operate and rotate

Assign or remove Researchers on the Entra enterprise application. The Project
Context foreign key is `ON DELETE RESTRICT`, so a local account cannot be
deleted while it owns research data.

FREE sessions never renew in place and expire eight hours after successful
sign-in, for both Microsoft Entra and local mock OIDC. The identity token must
have more than one minute remaining at sign-in; its later expiry does not end
the FREE session. Local mock OIDC issues 24-hour tokens.

On expiry, FREE redirects through the existing authorization-code flow. Entra
SSO may complete it without a credential prompt, subject to tenant policy.
Before the redirect the browser keeps unsaved schema drafts, in the schema
editor and in a Batch Schema Suggestion, in same-tab storage for up to 30
minutes, and restores them after sign-in only for the same account and
resource. No token-lifetime policy change or refresh-token storage is
required.

Removing enterprise-app assignment blocks the next sign-in, but an existing
FREE session can remain usable for up to eight hours. FREE has no
per-account emergency kill switch; rotating
`FREE_SESSION_SECRET` is the only immediate forced logout and invalidates every
session. Session and authorization-transaction signatures use separate HMAC
contexts even though both derive from that deployment secret.

For certificate rotation, upload the new public certificate before replacing
the mounted private key and thumbprint, re-run `node scripts/free.mjs
production` so Studio starts with them, complete a sign-in, then remove the old
certificate.
