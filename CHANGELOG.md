# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org): while the version is below 1.0.0, a minor release may change names or behavior.

## [Unreleased]

## [0.8.1] - 2026-10-25

### Fixed

- Memory receipts now count. Paseo's turn-end event no longer carries the turn's timeline, so receipts always read "not used yet". A receipt now reads the agent's timeline after the position it counted up to, saves that position with its totals, and never counts a call twice.

### Changed

- The suggestions card in an agent's chat is one line per suggestion: its title with small Approve and Reject actions; tapping the title shows its text. A small muted header holds the count and "Edit in Memorise".

## [0.8.0] - 2026-10-25

### Added

- A memory receipt in each agent's chat: one quiet line, "Memorise · 12 memories in this agent's prompt · opened 2, searched 1", that updates as the agent uses the memory tools. It is never sent to the model. "Show memory use in agent chats" in Settings (on by default) turns it off.
- Review keys for suggestions on desktop and in the browser: j and k (or the arrows) move, a approves, r rejects, with the focused suggestion outlined and scrolled into view. Keys typed into a field, or held with Cmd, Ctrl, or Alt, are ignored.

### Changed

- The weekly clean-up also checks when the plugin first sees Paseo, so reloading the plugin no longer pushes it back an hour.
- The navigation says "Loading projects" while the project list loads.

## [0.7.0] - 2026-10-25

### Changed

- Plain words everywhere you look, from one glossary (agents' tools and stored data keep their names):
  - repo → project;
  - Retire → Archive;
  - replaced → older version;
  - Proposed / Proposals → Suggestions;
  - Capture → Suggestions from sessions;
  - Tidy → Clean up;
  - Create from project / Re-check against project → Suggest from project files / Check memories against project files;
  - Auto-approve new memories → Save suggestions without review;
  - Host setting → Use global setting;
  - Listed / Only for matching files / Search only → Always / When matching files change / Only when searched;
  - Until → Expires on;
  - What agents get → What agents see;
  - Repo tools → Project settings.
- Project settings are real switches with fixed labels that say what "on" means, and they apply at once.
- Settings has a short main level (6 settings) and an Advanced section for limits, timing, models, and the tools port. Every description is one or two sentences and states its default.
- A memory card says who saved it, when ("3 days ago"), and how agents used it ("Not used yet"); cited files sit behind "Cites N files".
- The editor has visible labels (Title, Memory, Kind, About files, Expires on) and a real on/off switch.
- Each suggestion says where it came from (a session, project files, or a clean-up), which provider, and when, plus why when there is a reason.
- Projects are shown by their short name, with the full key underneath.
- Errors show only their own message, without Paseo's "Request failed: … requestType=… code=…" wrapping, and a pasted import that is not valid JSON says so without a raw "SyntaxError".
- Example text in empty fields is dimmed, so it can't be mistaken for content.

### Added

- Undo after archiving a memory, archiving several, or moving one between a project and Global.
- Empty states that say what to do next: "Suggest from project files" for a project with no memories, "Clear search and filters" when nothing matches.

### Removed

- The confirmation before "Approve all": an approved memory can be archived afterwards. Deleting and "Reject all" still ask, and name what they affect.

## [0.6.2] - 2026-10-24

### Changed

- The manager's Proposals view shows each repository as a collapsible card, collapsed at first with its name and how many proposals wait; open, it shows that repository's Approve all, Reject all, and proposals. Expand all and Collapse all open or close every card.

## [0.6.1] - 2026-10-24

### Fixed

- Background runs (capture, tidy, project scans) no longer leave a project named after a random id (such as `01M5QD6…`) in Paseo's sidebar. Each run used to make a workspace on a new folder, which made Paseo create a project that showed once the workspace was archived. Every worker now runs in one hidden workspace on the plugin's worker folder, made once and never archived.

## [0.6.0] - 2026-10-24

### Added

- Folders outside git keep their key when renamed or moved on the same disk. Memorise records each folder project's key in `folders.json` and finds the folder again by its disk identity; the manager shows the folder's current name.
- An agent started in a subfolder of a Paseo project outside git gets that project's memories, unless the subfolder has memories or proposals of its own (so memories saved there by 0.5.0 stay with it). A folder where an agent merely ran claims nothing below it; the home folder and the filesystem root are never project roots.
- In a folder outside git, memories about files changed in the last 7 days rank first, and "only for matching files" works.
- Agents in a folder outside git can cite files: each citation is pinned to the file's content, and the memory is marked "needs check" when the file changes or goes.

### Changed

- A citation is pinned to either a git commit or a file's content hash; stored citations read as before.
- A project scan reads from the project's root as Memorise resolves it.
- Project files and cited files are read by one reader that refuses symlinks and hard links, checks that the file read is the file checked, and stops at its size limit.

## [0.5.0] - 2026-10-24

### Added

- Memory for folders outside git. A folder that is not in a git repository is a project of its own, keyed by its path with its name in the key (such as `folder/notes-3f9a1c2b7d4e`). It has the features a repository has: memories and agent write tools, the manager and panel, capture, tidy, project scans, auto-approve, switches, and import and export. Ranking by changed files and citations need git history and are not available there.
- "Create memories from projects automatically" in Settings, off by default: once per project, or once and then a weekly re-check, for every project with an open Paseo workspace, git or not. Scans start when a workspace is created, when the plugin starts, and hourly, one at a time. They use at most half the daily limit of background runs, retry a failed first scan a day later, and skip projects with memory or capture turned off.

### Changed

- Agents in a folder outside git get that folder's memories and the write tools, instead of global memories only.
- A scan started by hand is remembered, so an automatic "once" scan does not repeat it.
- A project scan in a git repo reads from the repository root, and a git failure stops the scan instead of reading the current folder.
- A remote whose host is `folder` or `local` no longer maps onto the keys Memorise makes for folders and origin-less repos.

## [0.4.1] - 2026-10-24

### Fixed

- The manager lists every repository with an open Paseo workspace, and every repository with proposals waiting, beside those that have memories, so "Create from project" can be run on a repository before it has any memories.
- "Tidy all repos" covers only repositories with at least 2 memories, which is what tidy needs.

## [0.4.0] - 2026-10-24

### Added

- Memories from a project: "Create from project" proposes memories from the repository's README, contributing guide, docs, and build files; "Re-check against project" also proposes rewriting or retiring saved memories those files contradict. The plugin reads a fixed list of files from the repository root, under size limits, never through a symlink or a hard link, with secret-shaped text replaced; the instruction files (AGENTS.md, CLAUDE.md) are sent only so the scan leaves out what agents already read. From the manager, a scan reads a checkout of the repository that is open as a Paseo workspace.
- A Proposals view in the manager: every repository's waiting proposals in one place, and "Tidy all repos".
- "Approve all" and "Reject all" for a repository's proposals; each asks once, then decides exactly the proposals shown when asked.
- A per-repository "Auto-approve new memories" switch, off by default. On, new memories from capture or a project scan are saved without review and marked "auto"; rewrites, retirements, and tidy's proposals still wait for you.
- The Proposed tab shows how the last tidy or project scan went (running, finished with counts, or failed with the reason) and refreshes itself while one runs.

### Changed

- A tidy or project scan that cannot start (the daily limit is used up, fewer than 2 memories to tidy, no project files) now says so when you press the button, instead of starting nothing; a tidy whose worker reply is not valid is reported as failed.
- Project scans share the daily limit of background runs with capture and tidy.
- The chat card after a capture also says how many memories were saved automatically.

## [0.3.0] - 2026-10-24

### Added

- Settings inside the manager: a Settings item in its navigation shows the same settings as Settings > Plugins > Memorise.
- Proposals and tidy per repository in the manager (a Proposed tab), not only in a workspace's panel.
- "Needs attention": memories across global and every repository that agents cannot see (turned off, ended, or hidden after going unused) or have never used 14 days after they were saved.
- A prompt-budget line in "What agents get": lines and KB used out of the limits.

### Changed

- The manager is decluttered without removing anything: a left navigation; filters behind one Filters button with removable chips for active filters; bulk actions behind Select; repository switches and import/export behind Repo tools; cards with badges, three actions, and More; the editor's files, activation, on/off, and end date behind Options.
- The proposal and tidy calls take a repository key as well as a workspace folder, like every other memory call.

### Fixed

- Exports list memories saved in the same millisecond in a stable order.

## [0.2.1] - 2026-10-24

### Fixed

- The manager keeps the repository it was opened for, and the chosen one, in its repository list before they have any memories, so either can be chosen again.
- "Revert to this" and "Show prompt text" size to their label instead of stretching across the card.
- The export count says "1 memory" instead of "1 memories".

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

[Unreleased]: https://github.com/monarchmaisuriya/memorise/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.8.1
[0.8.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.8.0
[0.7.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.7.0
[0.6.2]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.6.2
[0.6.1]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.6.1
[0.6.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.6.0
[0.5.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.5.0
[0.4.1]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.4.1
[0.4.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.4.0
[0.3.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.3.0
[0.2.1]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.2.1
[0.2.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.2.0
[0.1.0]: https://github.com/monarchmaisuriya/memorise/releases/tag/v0.1.0
