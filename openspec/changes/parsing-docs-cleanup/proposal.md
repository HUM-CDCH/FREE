# Proposal: parsing-docs-cleanup

## Why

`TaskStorage` already serializes canonical JSON and Markdown as deterministic
UTF-8/LF bytes. The package contract checks stable archive bytes and manifest
digests, but it does not directly prove that equivalent LF, CRLF, and CR input
produce the same canonical bytes and digest.

## Remaining work

Add the platform-independent newline/digest regression test required by the
`canonical-document-parsing` delta. No runtime behavior or documentation
change remains in this change.
