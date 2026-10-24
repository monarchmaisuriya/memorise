# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org): while the version is below 1.0.0, a minor release may change names or behavior.

## [Unreleased]

## [0.1.0] - 2026-10-24

First release.

### Added

- Shared memory for Claude, Codex, and OpenCode agents, per repository (keyed by the `origin` remote, shared across clones and worktrees) and global (written only by you).
- A ranked memory list in each new agent's system prompt: pinned memories, then memories about files the worktree changed, then global ones, then the rest.
- Two local MCP servers, `paseo-memorise` (`memory_search`, `memory_read`) and `paseo-memorise-write` (`memory_write`, `memory_update`, `memory_retire`), with a per-agent token scoped to its repository.
- Full-text search, file citations pinned to a commit with "needs check" marks, secret refusal, a write limit per repository, an audit log, and usage counts.
- The `/remember` composer command, the Memorise workspace panel, and the settings screen.
- Optional capture and tidy: locked-down background agents propose memories, which wait in the Proposed tab for your approval.
- Install straight from Git: `paseo plugin add git:monarchmaisuriya/memorise`.
- The Memorise icon.

[Unreleased]: https://github.com/monarchmaisuriya/memorise/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.1.0
