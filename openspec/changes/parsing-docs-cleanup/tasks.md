# Tasks: parsing-docs-cleanup

- [x] Serialize canonical JSON and Markdown as deterministic UTF-8/LF bytes.
- [ ] Add a digest-stability test proving equivalent LF, CRLF, and CR canonical
  text inputs produce byte-identical artifacts independent of platform newline
  defaults.
