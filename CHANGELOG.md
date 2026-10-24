# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org): while the version is below 1.0.0, a minor release may change names or behavior.

## [Unreleased]

## [0.2.0] - 2026-10-24

### Added

- A Memorise row in the sidebar header opens a manager for global memory and every repository, without opening a workspace: search, filters (status, type, controls), sort, bulk actions, a full editor, version history with revert, and moving a memory between a repository and global. Command Center items open it for the current repository or globally.
- Per-memory controls, set only by you: when agents see it (listed, only for matching files, title only, search only), on or off, and an optional end date.
- Per-repository switches: memory off for new agents, keep global memories out, and a capture override.
- "What agents get" in the panel: exactly what a new agent in that workspace would be given, and why each memory is listed.
- Approve and reject captured memories from the chat card.
- Import and export: Markdown lines for reading, JSON that keeps paths and controls, and `[date] - text` lines from assistant memory exports, with a check before anything is written.

### Changed

- The editor sets the subject, type, paths, and pin directly; the subject is no longer cut from the first line.

### Notes

- Do not downgrade to 0.1.0 without exporting first: 0.1.0 drops the new per-memory controls when it rewrites a memory.

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

[Unreleased]: https://github.com/monarchmaisuriya/memorise/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.2.0
[0.1.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.1.0
