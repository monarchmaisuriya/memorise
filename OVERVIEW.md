Memorise gives Claude, Codex, and OpenCode agents one shared memory. A fact learned by one agent in one workspace reaches every later agent in any workspace of the same repository, whichever provider runs it. Your own preferences, saved as global memories, reach agents in every repository.

## How it works

Each memory is one short fact in its own Markdown file on the daemon host, under `plugin-data/memorise/` in your Paseo home. Repository memories are grouped by the repository's `origin` remote, so clones and worktrees share them. A clone whose origin uses an SSH host alias (such as `work-github:owner/repo`) is grouped under that alias, apart from clones that use the real host. A repository without an origin is grouped by its git folder, which its worktrees share. A folder outside git is a project of its own, grouped by its path, with the same features except ranking by changed files and citations, which need git.

When a supported agent is created, the plugin adds two things to it:

- A short list of current memories in its system prompt, at most 150 lines and 8 KB. Memories you pinned come first (up to 20), then memories about files this worktree has changed, then global memories, then the rest of the repository's. The list says the entries are notes to verify, not instructions.
- Two local MCP tool servers. `paseo-memorise` has `memory_search` (full-text search ranked by relevance, optionally limited to memories about given files) and `memory_read`. `paseo-memorise-write` has `memory_write`, `memory_update`, and `memory_retire`.

A memory about code can cite files by their path from the repository root, or name file globs such as `src/api/**`. The plugin records the commit at the time of citing. When a cited file has changed since then, the list marks that memory "needs check" so the agent verifies it first. Rewording a memory keeps its original citations; citing again records the current commit.

## Capture, tidy, and project scans (optional)

Capture is off until you turn it on. When it is on and a session has been idle for a while (20 minutes by default), a background agent reads what happened since the last capture and proposes memories. Tidy, run from the Memory panel or weekly, proposes merging duplicates, rewording unclear memories, and retiring obsolete ones. A project scan ("Create from project" or "Re-check against project") proposes memories from the repository's README, docs, and build files, or fixes to saved ones those files contradict. Proposals wait in the Proposed tab and in the manager's Proposals view; nothing reaches an agent until you approve it, and you can edit the wording first. A repository can turn on auto-approve, which saves new memories from capture and project scans without review and marks them "auto". Project scans can also run on their own, once per project with an open workspace or weekly (Settings, off by default). A finished capture adds a "memories proposed" card to the session's chat; the card is never sent to the model.

The background agents read text that may contain instructions planted in a session, so their tools are switched off through each provider's own options, they run in an empty folder of their own, and the plugin denies every permission request they make:

- Claude: every built-in tool and Paseo's own tools are disallowed, and your own MCP servers are not loaded.
- OpenCode: a single rule denies every tool, Paseo's included.
- Codex cannot switch off its shell. Its workers run in a read-only sandbox without network or web search, and anything beyond reading must ask, which the plugin denies. A misled Codex worker could still read files and put what it read into a proposal, which you see before approving.

Workers are archived when they finish, and leftovers from an interrupted run are removed when the plugin next starts.

- By default each session is read by the provider that ran it, so no transcript is sent to another provider. You can choose one provider for all sessions instead.
- The transcript sent is a summary: your messages, the agent's replies, commands with exit codes, and files touched. Secret-shaped text is replaced before it is sent. Reasoning and tool output are left out.
- With no model set, the provider's default model is used, which for Claude is its largest model. A model can be set only together with one fixed provider, since a model id belongs to one provider.
- Capture waits until you have sent at least 3 new messages since the last capture of that session. Capture, tidy, and project scans together run at most 10 times a day; each run is one model call. A reply that is not valid is not retried for the same turns.
- Tidy reads only the repository's saved memories, which agents already see in their prompts.

## What agents can and cannot do

- Through the memory tools, agents write only to their own repository's memories. Global memories come only from you, through `/remember --global` or the Memory panel. The files themselves belong to your user account, so a program or agent with shell access running as you could still edit them directly. Saved text is always shown to agents as quoted notes: it cannot add lines to the list or end it.
- Agents can replace or retire a memory but never delete, pin, move, turn off, or end-date one. A replaced memory is kept as history, and you can restore a retired one from the Memory panel.
- Writes that look like they contain a secret (private keys, cloud and GitHub tokens, `password=` assignments, text inside `<private>` tags) are refused with the reason. Each repository allows at most 20 agent writes, replacements, and retirements per hour.
- Reading memory is approved automatically; saving, changing, or retiring a memory asks you like any other tool, unless the agent runs in a mode that skips approvals (such as bypass or full access). You can turn automatic read approval off.
- Every tool call is logged to `plugin-data/memorise/audit.jsonl` with time, repository, provider, tool, and memory id, but not the memory text. How often each memory was shown, read, and found is counted in `usage.jsonl` (ids only) and shown in the panel.

## Using it

- `/remember [--global] [preference|decision|gotcha|howto|reference:] <fact>` in the composer saves a memory for the workspace's repository, or for all repositories with `--global`.
- The Memorise row in the sidebar opens the manager for global memory and every repository: search, filters, sort, bulk actions, a full editor, version history with revert, per-repository switches, proposals across every repository with approve all and reject all, tidy, project scans, auto-approve, import/export (Markdown or JSON), a "Needs attention" view of memories agents cannot see or never use, and the plugin's settings.
- The Memorise workspace panel lists the workspace's repository memories plus global ones, links to the manager, and shows exactly what a new agent there would get, and why.
- Each memory has controls only you set: when agents see it (listed, only for matching files, title only, or search only), on or off, and an optional end date.
- Approve or reject captured memories from the chat card, or edit them in the panel's Proposed tab.
- Settings > Plugins > Memorise: memory on or off for new agents, automatic read approval, how many memories go in the prompt, how long an agent-written memory that no agent has found or read stays listed (60 days by default; memories you saved or pinned never expire), the local port of the tool servers (6790 by default), and the capture and tidy options above.

## Limits

- Only agents created after the plugin is installed get memory. Running agents keep the prompt and tools they started with.
- Memory text is sent to each agent's model provider as part of its prompt.
- Search matches words, not meaning. If the search index cannot be opened, keyword search is off and search by files still works.
- Paseo does not replay events, so sessions that end while the plugin is stopped are not captured. A capture that fails is retried at the next idle, within the daily limit.
- With OpenCode, the notes always reach the agent, but some models follow Code Mode's instruction to use only `execute` and skip the memory tools, which Paseo connects as ordinary tools. Asking the agent to list its tools, or using a model that calls ordinary tools, works around it.
- Tested with Paseo 0.12.0 on macOS, with Claude, Codex, and OpenCode. Requires git on the daemon host (folders outside git work too).
