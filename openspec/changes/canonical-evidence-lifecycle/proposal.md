## Why

`parsed_document.v2` now publishes canonical Evidence Anchors, but Studio still
projects the retained document to a v1-shaped DTO and cannot persist or reopen
the anchors selected during extraction review. Issue 72 needs one deterministic
parse-to-render lifecycle proof before any further model sampling.

## What Changes

- Reuse the v2 document returned by the Parsing Service without a v1 projection
  or `/parsed-document` compatibility path.
- Persist a fixed accepted Extraction Result together with a Review Decision
  whose `reviewedOccurrenceIds` belong to canonical anchors referenced by that
  result. Models do not generate a second Evidence tree.
- Reopen the persisted result in a fresh browser session and resolve the same
  generation-scoped anchors.
- Render valid page geometry and suppress invalid or rotated geometry.
- Add one deterministic intercepted browser fixture using the Ellekilde
  semantic golden and a fixed accepted row `24-1` result.

## Capabilities

### New Capabilities

- `canonical-evidence-lifecycle`: Persist, reopen, resolve, and safely render
  canonical Evidence and reviewed occurrence identity.

### Modified Capabilities

None.

## Impact

The change touches the Studio Source Representation DTO/proxy, `ProjectStore`
and its Prisma contract, reopen/write APIs, browser Evidence rendering, and one
persistence Playwright flow. It adds no provider calls or dependencies.
