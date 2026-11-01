# 0025: Deployment-owned Claude Code extraction

Date: 2026-11-01. Status: accepted; extends [0021](0021-deployment-owned-codex-extraction.md).

## Context

Studio already offers the operator's Claude Code login as a deployment connection for schema work, authenticated
by `CLAUDE_CODE_OAUTH_TOKEN`. A deployment without extraction GPUs could use Codex only. Extraction through Claude
Code must keep the guarantees 0021 set for Codex: one durable path, pinned requests, no tools, and usage that is
verified against an explicit reservation rather than claimed as an exact count.

## Decision

A deployment may select `KEI_EXTRACT_PROVIDER=claude-code` and a full Claude model ID for both extraction roles.
Its provider is the adapter `claude-code` with the fixed URL `claude://local`. The Parsing Service contains the
standalone `claude` executable at the version Studio pins; the operator's token reaches the service and worker as
`CLAUDE_CODE_OAUTH_TOKEN`. Researcher keys and Model Connections do not enter extraction execution.

Each provider call runs one `claude -p` process with stream-JSON output in an empty directory that is also its home
and configuration directory, so user settings, memory, hooks and plugins never load. The child receives only the
token, locale, proxy and certificate variables of the worker's environment. All built-in tools, MCP servers, setting
sources and skills are off; the CLI's structured-output tool, which carries the reply, is the only tool offered or
accepted. Non-essential traffic is disabled: without that setting the CLI sends a background request to a second
model. Any other tool, server tool, compaction, or a usage report naming a model other than the selected one fails
the call. `--max-turns 2` stops a structured-output retry.

The CLI has no model catalog. The listing offers the deployment model alone and reports it reachable when
`claude auth status` sees a configured credential, without starting a model turn. `--bare` is not used: it accepts
only API keys.

The versioned `claude:utf8-budget-v1` policy reserves request UTF-8 bytes plus 4,096 framing tokens under a
65,536-token planning ceiling; CLI 2.1.263 measured about 750 framing tokens. The budget also keeps system prompt
and schema below Linux's 128 KiB single-argument limit, which matters because the CLI accepts its schema only inline.
Input usage is the sum of uncached, cache-read and cache-creation input tokens. A completed reply is accepted only
when that sum fits its reservation, the reported context window covers the planning ceiling, and output usage fits
the reply reserve. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is set to the reserve; the CLI continues a cut-off reply in further
requests before failing, so the cumulative output check, not that setting, is the guarantee. A forward migration
admits this adapter and policy beside Codex's; neither accepts the other's policy.

## Consequences

Claude Code extraction uses the operator's account, its rate limits and its terms of use; batch work reaches a
subscription's limits quickly. Like Codex, output limits are verified after inference. The smaller framing allowance
refuses fewer small counted budgets than Codex. Choosing a different model requires restarting with another
`KEI_CLAUDE_MODEL`. A future policy change must use another version and must not reinterpret an existing capture.
