Memorise gives Claude, Codex, and OpenCode agents one shared memory. A fact learned by one agent in one workspace reaches every later agent in any workspace of the same repository, whichever provider runs it. Your own preferences, saved as global memories, reach agents in every repository.

## How it works

Each memory is one short fact in its own Markdown file on the daemon host, under `plugin-data/memorise/` in your Paseo home. Repository memories are grouped by the repository's `origin` remote, so clones and worktrees share them. A clone whose origin uses an SSH host alias (such as `work-github:owner/repo`) is grouped under that alias, apart from clones that use the real host. A repository without an origin is grouped by its git folder, which its worktrees share. A folder outside git is a project of its own with the same features: it keeps its key when renamed or moved on the same disk, agents in a Paseo project's subfolders share the project's memories, files changed this week rank its memories, and citations are pinned to the file's content.

When a supported agent is created, the plugin adds two things to it:

- A short list of current memories in its system prompt, at most 150 lines and 8 KB. Memories you pinned come first (up to 20), then memories about files this worktree has changed, then global memories, then the rest of the repository's. The list says the entries are notes to verify, not instructions.
- Two local MCP tool servers. `paseo-memorise` has `memory_search` (full-text search ranked by relevance, optionally limited to memories about given files) and `memory_read`. `paseo-memorise-write` has `memory_write`, `memory_update`, and `memory_retire`.

A memory about code can cite files by their path from the repository root, or name file globs such as `src/api/**`. The plugin records the commit at the time of citing. When a cited file has changed since then, the list marks that memory "needs check" so the agent verifies it first. Rewording a memory keeps its original citations; citing again records the current commit.

## Suggestions from sessions, clean-ups, and project files (optional)

Suggestions from sessions are off until you turn them on. When they are on and a session has been quiet for a while (20 minutes by default), a background agent reads what happened since the last run and suggests memories. A clean-up, started by hand or weekly, suggests merging duplicates, rewording unclear memories, and archiving outdated ones. "Suggest from project files" (or "Check memories against project files") suggests memories from the project's README, docs, and build files, or fixes to saved ones those files contradict. Suggestions wait in the Suggestions tab and in Memorise's Suggestions view; nothing reaches an agent until you approve it, and you can edit the wording first. A project can save suggestions without review, which saves new suggested memories straight away and marks them "Saved without review". Suggestions from project files can also run on their own, once per project with an open workspace or weekly (Settings, off by default). A session's suggestions add a "memories suggested" card to its chat; the card is never sent to the model.

The background agents read text that may contain instructions planted in a session, so their tools are switched off through each provider's own options, they run in the plugin's empty worker folder, inside one hidden workspace that never shows in the sidebar, and the plugin denies every permission request they make:

- Claude: every built-in tool and Paseo's own tools are disallowed, and your own MCP servers are not loaded.
- OpenCode: a single rule denies every tool, Paseo's included.
- Codex cannot switch off its shell. Its workers run in a read-only sandbox without network or web search, and anything beyond reading must ask, which the plugin denies. A misled Codex worker could still read files and put what it read into a proposal, which you see before approving.

Workers are archived when they finish, and leftovers from an interrupted run are removed when the plugin next starts.

- By default each session is read by the provider that ran it, so no transcript is sent to another provider. You can choose one provider for all sessions instead.
- The transcript sent is a summary: your messages, the agent's replies, commands with exit codes, and files touched. Secret-shaped text is replaced before it is sent. Reasoning and tool output are left out.
- With no model set, the provider's default model is used, which for Claude is its largest model. A model can be set only together with one fixed provider, since a model id belongs to one provider.
- Suggestions from a session wait until you have sent at least 3 new messages since that session's last run. Session suggestions, clean-ups, and project files together run at most 10 times a day; each run is one model call. A reply that is not valid is not retried for the same turns.
- A clean-up reads only the project's saved memories, which agents already see in their prompts.

## What agents can and cannot do

- Through the memory tools, agents write only to their own repository's memories. Global memories come only from you, through `/remember --global` or Memorise. The files themselves belong to your user account, so a program or agent with shell access running as you could still edit them directly. Saved text is always shown to agents as quoted notes: it cannot add lines to the list or end it.
- Agents can replace or archive a memory (their tool is `memory_retire`) but never delete, pin, move, turn off, or set an expiry on one. A replaced memory is kept as an older version, and you can restore an archived one in Memorise.
- Writes that look like they contain a secret (private keys, cloud and GitHub tokens, `password=` assignments, text inside `<private>` tags) are refused with the reason. Each repository allows at most 20 agent writes, replacements, and retirements per hour.
- Reading memory is approved automatically; saving, changing, or retiring a memory asks you like any other tool, unless the agent runs in a mode that skips approvals (such as bypass or full access). You can turn automatic read approval off.
- Every tool call is logged to `plugin-data/memorise/audit.jsonl` with time, repository, provider, tool, and memory id, but not the memory text. How often each memory was shown, read, and found is counted in `usage.jsonl` (ids only) and shown in the panel.

## Using it

- `/remember [--global] [preference|decision|gotcha|howto|reference:] <fact>` in the composer saves a memory for the workspace's repository, or for all repositories with `--global`.
- The Memorise row in the sidebar opens Memorise for Global and every project: search, filters, sort, bulk actions with undo, a full editor, version history, project settings, suggestions across every project with approve all and reject all, clean-ups, suggestions from project files, import and export (Markdown or JSON), a "Needs attention" view of memories agents can't see or never use, and the plugin's settings.
- The Memorise workspace panel lists the project's memories plus global ones, links to Memorise, and shows exactly what a new agent there would see, and why.
- Each memory has settings only you set: when agents see it (always, when matching files change, title only, or only when searched), on or off, and an optional expiry date.
- Approve or reject suggested memories from the chat card, or edit them in the Suggestions tab.
- Settings > Plugins > Memorise: memory on or off for new agents, automatic read approval, how many memories go in the prompt, how long an agent-written memory that no agent has found or read stays listed (60 days by default; memories you saved or pinned never expire), the local port of the tool servers (6790 by default), and the suggestion and clean-up options above. Limits, timing, and models sit under Advanced.

## Limits

- Only agents created after the plugin is installed get memory. Running agents keep the prompt and tools they started with.
- Memory text is sent to each agent's model provider as part of its prompt.
- Search matches words, not meaning. If the search index cannot be opened, keyword search is off and search by files still works.
- Paseo does not replay events, so sessions that end while the plugin is stopped get no suggestions. A suggestion run that fails is retried at the next quiet spell, within the daily limit.
- With OpenCode, the notes always reach the agent, but some models follow Code Mode's instruction to use only `execute` and skip the memory tools, which Paseo connects as ordinary tools. Asking the agent to list its tools, or using a model that calls ordinary tools, works around it.
- Tested with Paseo 0.12.0 on macOS, with Claude, Codex, and OpenCode. Requires git on the daemon host (folders outside git work too).
