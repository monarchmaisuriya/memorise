# memorise

Agent memory for [Paseo](https://paseo.sh): one shared memory for Claude, Codex, and OpenCode agents.

A fact one agent learns in one workspace reaches every later agent in any workspace of the same repository, whichever provider runs it. Your own preferences, saved as global memories, reach agents in every repository.

The plugin's id in Paseo is `agent-memory`.

## What it does

- **Remembers per repository.** Memories are grouped by the repository's `origin` remote, so clones and worktrees of the same repo share them.
- **Remembers for you.** Global memories (your preferences, conventions) reach agents in every repository. Only you can write them.
- **Shows agents what matters first.** Each new agent gets a short list in its system prompt: pinned memories, then memories about files this worktree has changed, then global ones, then the rest of the repository's.
- **Gives agents tools.** `memory_search`, `memory_read`, `memory_write`, `memory_update`, and `memory_retire`, over two local MCP servers.
- **Flags stale facts.** A memory can cite files. When a cited file has changed since the memory was written, the list marks it "needs check".
- **Refuses secrets.** Writes that look like private keys, cloud or GitHub tokens, or `password=` assignments are refused.
- **Optionally captures and tidies.** Background agents can propose new memories from finished sessions and propose merges or retirements. Nothing reaches an agent until you approve it.

## Requirements

- Paseo `>=0.12.0 <0.14.0` (tested with 0.12.0 on macOS).
- git and npm on the daemon host.
- At least one of the Claude, Codex, or OpenCode providers set up in Paseo.

## Install

Clone the repository on the machine that runs the Paseo daemon, install its dependencies, and install the folder as a plugin:

```bash
git clone https://github.com/monarchmaisuriya/memorise.git
cd memorise
npm install
paseo plugin install "$PWD"
```

Check that it is running:

```bash
paseo plugin ls
```

The `agent-memory` row should say `running`. Logs are in `paseo plugin logs agent-memory`, or Settings > Plugins > Logs.

Only agents created after the install get memory. Agents already running keep the prompt and tools they started with.

## Using it

- **Save a memory from the composer:** `/remember [--global] [preference|decision|gotcha|howto|reference:] <fact>`. Without `--global` it is saved for the workspace's repository.
- **Browse and edit:** open the Agent memory workspace panel (also in the Command Center). It lists the repository's memories and the global ones, with how often each was shown, read, and found. You can add, edit, pin, retire, restore, and delete memories there.
- **Review proposals:** the panel's Proposed tab lists what capture and tidy suggested. Edit the text or file paths, then approve or reject.
- **Let agents do it:** agents search and read memory on their own, and save what they learn with the write tools.

## Settings

Settings > Plugins > Agent memory.

| Setting | Default | Notes |
| --- | --- | --- |
| Give new agents memory | on | |
| Approve memory reads automatically | on | Saving, changing, or retiring asks like any other tool, unless the agent runs in a mode that skips approvals |
| Memories listed in each new agent's prompt | 150 | 0 lists none (agents still get the tools); up to 400. The list is also capped at 8 KB |
| Hide agent-written memories unused for (days) | 60 | 0 never hides them. Memories you saved or pinned never expire |
| Local port for the memory tools | 6790 | Takes effect after reloading the plugin |
| Propose memories from finished sessions | off | Capture; see below |
| Provider that reads the session | Same as the session | So no transcript leaves the provider that ran it |
| Capture model | empty | Only applies when one provider reads every session; empty uses the provider's default model |
| Capture after the agent is idle for (minutes) | 20 | 5 to 240; a new turn restarts the wait |
| Capture once you have sent at least this many new messages | 3 | 1 to 50, counted since the last capture of that session |
| Background runs per day, at most (capture and tidy) | 10 | 1 to 100; each run is one model call |
| What to capture / What never to capture | empty | Optional guidance, up to 2,000 characters each |
| Provider that tidies / Tidy model | claude / empty | |
| Tidy each repo weekly | off | Tidy can also be started from the panel |

With no model set, a provider's default model is used, which for Claude is its largest model. Set a smaller model with a fixed provider to keep capture cheap.

## How it works

```
agent created in a workspace
        |
        v
plugin finds the repo key from the origin remote   e.g. github.com/acme/api
        |
        v
reads memories: repo + global  -->  ranks them  -->  adds the list to the system prompt
        |
        v
adds two MCP servers with a token for this agent's repo
  paseo-agent-memory        memory_search, memory_read
  paseo-agent-memory-write  memory_write, memory_update, memory_retire
```

Everything is stored as files on the daemon host, under `plugin-data/agent-memory/` in your Paseo home (`~/.paseo` by default):

| Path | What it holds |
| --- | --- |
| `repos/<repo key>/<id>.md` | One repository memory per Markdown file, metadata in YAML frontmatter |
| `global/<id>.md` | Global memories |
| `proposals/` | Proposals waiting for review, and the hashes of rejected ones |
| `audit.jsonl` | Every tool call: time, repository, provider, tool, memory id (never the text) |
| `usage.jsonl` | How often each memory was shown, read, and found (ids only) |
| `index.sqlite` | Full-text search index; a cache rebuilt from the Markdown files |
| `secret` | Key that signs the per-agent tool tokens |

The Markdown files are the source of truth. Updating a memory writes a new file that names the old one, so the history is kept and a crash cannot leave two current versions.

A repository without an origin is grouped by its git folder, which its worktrees share. A clone whose origin uses an SSH host alias (such as `work-github:owner/repo`) is grouped under that alias.

## Capture and tidy

Both are off until you turn them on.

- **Capture:** when a session has been idle for a while, a background agent reads a summary of what happened since the last capture and proposes memories. The summary holds your messages, the agent's replies, commands with exit codes, and files touched. Secret-shaped text is replaced before it is sent; reasoning and tool output are left out.
- **Tidy:** proposes merging duplicates, rewording unclear memories, and retiring obsolete ones. It reads only the repository's saved memories.

The background agents read text that may contain instructions planted in a session, so their tools are switched off and every permission request they make is denied:

- **Claude:** every built-in tool and Paseo's own tools are disallowed, and your own MCP servers are not loaded.
- **OpenCode:** one rule denies every tool. OpenCode's free models refuse background agents, so capture there needs a paid model.
- **Codex:** cannot switch off its shell. Its workers run in a read-only sandbox with no network and no web search. A misled Codex worker could still read files and put what it read into a proposal, which you see before approving.

Workers run in an empty folder of their own and are archived when they finish.

## What agents can and cannot do

- Agents write only to their own repository's memories, never to global ones.
- Agents can replace or retire a memory, but never delete or pin one. You can restore a retired memory from the panel.
- Each repository allows at most 20 agent writes, replacements, and retirements per hour.
- Saved text is always shown to agents as quoted notes, marked as notes to verify rather than instructions. It cannot add lines to the list or end it.
- The files belong to your user account, so any program running as you, including an agent with shell access, could edit them directly.

## Limits

- Memory text is sent to each agent's model provider as part of its prompt.
- Search matches words, not meaning. If the search index cannot be opened, keyword search is off and search by files still works.
- Sessions that end while the plugin is stopped are not captured; Paseo does not replay events.
- With OpenCode, the notes always reach the agent, but some models follow Code Mode's instruction to use only `execute` and skip the memory tools ([getpaseo/paseo#7772](https://github.com/getpaseo/paseo/issues/7772)).
- OpenCode agents can save memories without asking, even in plan mode; that is OpenCode's own permission behavior.

## Development

```bash
npm install
npm test
npm run typecheck
```

`npm test` runs the Vitest suite; the tests create their temporary folders through `server/test-temp-dir.ts`, which removes them after each test. `npm run typecheck` checks the app side and the daemon side separately.

After changing the code, reload the plugin so the daemon picks it up:

```bash
paseo plugin reload agent-memory
```

| Folder | Runs in |
| --- | --- |
| `index.client.tsx`, `client/` | the Paseo app: panel, `/remember`, settings screen, chat card |
| `index.server.ts`, `server/` | the daemon's plugin process: store, MCP servers, prompt section, capture, tidy |
| `shared/` | both: schemas, RPC contracts, settings |

`OVERVIEW.md` is the description Paseo shows for the plugin.
