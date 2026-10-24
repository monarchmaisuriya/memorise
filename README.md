<img src="assets/icon.png" alt="Memorise logo" width="96">

# memorise

Memorise for [Paseo](https://paseo.sh): one shared memory for Claude, Codex, and OpenCode agents.

A fact one agent learns in one workspace reaches every later agent in any workspace of the same repository, whichever provider runs it. Your own preferences, saved as global memories, reach agents in every repository.

The plugin's id in Paseo is `memorise`.

## What it does

- **Remembers per repository.** Memories are grouped by the repository's `origin` remote, so clones and worktrees of the same repo share them. A folder outside git is a project of its own, with the same features.
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

Install straight from GitHub:

```bash
paseo plugin add git:monarchmaisuriya/memorise
```

Paseo clones the repository and runs the manifest's `build` command, `npm ci --omit=dev --ignore-scripts`, which installs only the runtime packages from the committed lock file.

To install a specific release instead of the latest commit, name its tag:

```bash
paseo plugin add git:monarchmaisuriya/memorise --ref v0.5.0
```

Move an existing install to another release with `paseo plugin update memorise --ref <tag>`. Releases and their changes are listed in [CHANGELOG.md](CHANGELOG.md).

To work on the code instead, clone it and install the folder; Paseo then runs the plugin from your clone:

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

The `memorise` row should say `running`. Logs are in `paseo plugin logs memorise`, or Settings > Plugins > Logs.

Only agents created after the install get memory. Agents already running keep the prompt and tools they started with.

## Using it

- **Save a memory from the composer:** `/remember [--global] [preference|decision|gotcha|howto|reference:] <fact>`. Without `--global` it is saved for the workspace's repository.
- **Manage everything from the sidebar:** the Memorise row in the sidebar header opens the manager. Its left navigation lists global memory and every repository that has memories, an open Paseo workspace, or proposals waiting, then **Proposals**, **Needs attention**, and **Settings**. Show, hide, or move the row in Paseo's Settings > Sidebar. The Command Center has "Open Memorise manager" and "Open Memorise manager for this repo".
  - **A scope's memories:** search, plus a **Filters** button (status, type, controls, sort); active filters show as chips you can remove. **Select** turns on bulk actions (pin, turn on or off, retire, restore, delete). **Repo tools** (or **Import and export** for global) holds the repository's switches and import/export. Each repository also has a **Proposed** tab with its proposals, **Create from project**, **Re-check against project**, and tidy.
  - **Each memory:** badges for its type and controls, then Edit, Pin, Turn off, and **More** (retire or restore, make global or move to this repo, history with revert, delete). In the editor, **Options** holds files, when agents see it, on/off, and the end date.
  - **Proposals:** every repository's waiting proposals in one place, each repository with **Approve all** and **Reject all**, and **Tidy all repos** (those with at least 2 memories) at the top.
  - **Needs attention:** across global and every repository, the memories agents cannot see (turned off, ended, or hidden after going unused) and those never shown, read, or found 14 days after they were saved.
  - **Settings:** the same settings as Settings > Plugins > Memorise, without leaving the manager.
- **Work inside a workspace:** the Memorise workspace panel lists the repository's memories and the global ones, with the same card and editor, and "Open in manager".
- **See what agents get:** the panel's "What agents get" tab shows exactly what a new agent started in that workspace would be given, why each memory is listed (pinned, about files this worktree changed, global, or this repo), and how much of the prompt budget (lines and KB) it uses.
- **Review proposals:** approve or reject captured memories straight from the "memories proposed" card in the agent's chat, or edit them first in the Proposed tab of the panel or the manager. With several waiting, **Approve all** and **Reject all** decide them together.
- **Let agents do it:** agents search and read memory on their own, and save what they learn with the write tools.

### Per-memory controls

Set in the editor; agents can never change them.

| Control | Values | Effect |
| --- | --- | --- |
| When agents see it | Listed (default), Only for matching files, Title only, Search only | Listed: ranked into every new agent's list. Only for matching files: listed only when the worktree changed a file matching its paths (needs at least one path). Title only: listed by subject; the agent reads the text with `memory_read`. Search only: never listed, found only by `memory_search` |
| On for agents | on (default) / off | Off hides it from agents' lists, search, and read without deleting it |
| Until | a date, or empty (default) | After that day (UTC) agents no longer see it; the manager shows it as ended |

A pinned memory is always listed in full. Editing the subject, text, type, or paths saves a new version (kept in History); changing a control does not.

### Per-repository switches

In the manager or the panel's "What agents get" tab, shared by every clone and worktree of the repository:

- **Memory on / off:** off gives new agents in this repo no memories and no memory tools.
- **Includes global memories / Repo memories only:** keeps your global memories out of this repo's agents (list, search, and read).
- **Capture:** follow the host setting, or turn capture on or off for this repo only.
- **Auto-approve new memories:** off by default. On, new memories that capture or a project scan propose are saved without waiting for you, marked "auto", and hidden after going unused like an agent's. Rewrites, retirements, and tidy's proposals still wait for you.

### Import and export

Export a repository's (or global) current memories as Markdown, one `- [type] subject: body` line each, or as JSON, which keeps paths and controls. Import either, or the `[date] - text` lines that assistant memory exports produce. Every entry passes the same checks as a memory you save (length, no secrets); duplicates are skipped and named, and "Check" shows what would be added before anything is written.

## Settings

Settings > Plugins > Memorise.

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
| Background runs per day, at most (capture, tidy, and project scans) | 10 | 1 to 100; each run is one model call |
| What to capture / What never to capture | empty | Optional guidance, up to 2,000 characters each |
| Provider that tidies / Tidy model | claude / empty | Also used by project scans |
| Tidy each repo weekly | off | Tidy can also be started from the panel |
| Create memories from projects automatically | off | Once per project, or once then a weekly re-check; see below |

With no model set, a provider's default model is used, which for Claude is its largest model. Set a smaller model with a fixed provider to keep capture cheap.

## How it works

```
agent created in a workspace
        |
        v
plugin finds the repo key from the origin remote   e.g. github.com/acme/api
  (a folder outside git: from its path)            e.g. folder/notes-3f9a1c2b7d4e
        |
        v
reads memories: repo + global  -->  ranks them  -->  adds the list to the system prompt
        |
        v
adds two MCP servers with a token for this agent's repo
  paseo-memorise        memory_search, memory_read
  paseo-memorise-write  memory_write, memory_update, memory_retire
```

Everything is stored as files on the daemon host, under `plugin-data/memorise/` in your Paseo home (`~/.paseo` by default):

| Path | What it holds |
| --- | --- |
| `repos/<repo key>/<id>.md` | One repository memory per Markdown file, metadata in YAML frontmatter |
| `global/<id>.md` | Global memories |
| `proposals/` | Proposals waiting for review, and the hashes of rejected ones |
| `repo-prefs.json` | Per-repository switches (memory on/off, include global, capture) |
| `audit.jsonl` | Every tool call: time, repository, provider, tool, memory id (never the text) |
| `usage.jsonl` | How often each memory was shown, read, and found (ids only) |
| `index.sqlite` | Full-text search index; a cache rebuilt from the Markdown files |
| `secret` | Key that signs the per-agent tool tokens |

The Markdown files are the source of truth. Updating a memory writes a new file that names the old one, so the history is kept and a crash cannot leave two current versions.

A repository without an origin is grouped by its git folder, which its worktrees share. A clone whose origin uses an SSH host alias (such as `work-github:owner/repo`) is grouped under that alias.

A folder outside git is grouped by its own path, under a key such as `folder/notes-3f9a1c2b7d4e` that carries its name. It has everything a repository has (memories, agent tools, the manager and panel, capture, tidy, project scans, auto-approve, switches, import and export), except what needs git history: ranking by files the checkout changed, and citations pinned to a commit. Moving or renaming the folder gives it a new key; export and import carry its memories over.

## Capture, tidy, and project scans

Capture and weekly tidy are off until you turn them on; tidy and project scans can also be started by hand.

- **Capture:** when a session has been idle for a while, a background agent reads a summary of what happened since the last capture and proposes memories. The summary holds your messages, the agent's replies, commands with exit codes, and files touched. Secret-shaped text is replaced before it is sent; reasoning and tool output are left out.
- **Tidy:** proposes merging duplicates, rewording unclear memories, and retiring obsolete ones. It reads only the repository's saved memories.
- **Project scan:** **Create from project** proposes memories from the repository's own files; **Re-check against project** also proposes rewriting or retiring saved memories those files contradict. Memorise itself reads a fixed list from the repository root: the README, the contributing guide, up to 8 `docs/*.md`, `package.json` (name, scripts, engines, package manager, workspaces), `Makefile`, `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.tool-versions`, and `.nvmrc`. Each file is cut at 8 KB and all of them at 64 KB (the instruction files and build files first), symlinks, hard links, and binary files are skipped, and secret-shaped text is replaced. `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` are sent only so the scan leaves out what agents already read. From the manager, a scan reads a checkout of that repository that is open as a Paseo workspace. In a folder outside git, the scan reads the folder itself.
- **Automatic project scans:** with "Create memories from projects automatically" set to **Once per project**, every project with an open Paseo workspace (git or not) gets one Create from project scan; **Once, then re-check weekly** also re-checks it a week after its last scan. Scans start when a workspace is created, when the plugin starts, and hourly, one at a time. Automatic scans stop for the day once background runs reach half the daily limit, which leaves the rest for capture and for scans you start. A first scan that fails is tried again a day later. A scan you started by hand counts; a project with memory off, or with capture turned off for it, is skipped; the plugin's own worker folders are never scanned. The results are proposals, saved straight away only where the project has auto-approve on.

The background agents read text that may contain instructions planted in a session, so their tools are switched off and every permission request they make is denied:

- **Claude:** every built-in tool and Paseo's own tools are disallowed, and your own MCP servers are not loaded.
- **OpenCode:** one rule denies every tool. OpenCode's free models refuse background agents, so capture there needs a paid model.
- **Codex:** cannot switch off its shell. Its workers run in a read-only sandbox with no network and no web search. A misled Codex worker could still read files and put what it read into a proposal, which you see before approving.

Workers run in an empty folder of their own and are archived when they finish.

## What agents can and cannot do

- Agents write only to their own repository's memories, never to global ones.
- Agents can replace or retire a memory, but never delete, pin, move, turn off, or end-date one, import memories, or change a repository's switches. You can restore a retired memory, or revert to an older version, from the manager.
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
paseo plugin reload memorise
```

| Folder | Runs in |
| --- | --- |
| `index.client.tsx`, `client/` | the Paseo app: panel, `/remember`, settings screen, chat card |
| `index.server.ts`, `server/` | the daemon's plugin process: store, MCP servers, prompt section, capture, tidy |
| `shared/` | both: schemas, RPC contracts, settings |

`OVERVIEW.md` is the description Paseo shows for the plugin.

## Releasing

Versions follow [Semantic Versioning](https://semver.org). `package.json` holds the version, and each release is an annotated Git tag `v<version>` on the release commit.

1. Pick the next version: patch (`0.1.1`) for fixes, minor (`0.2.0`) for new features. Below 1.0.0, a change that renames or breaks something is also a minor release; from 1.0.0 on, it is a major release.
2. In `CHANGELOG.md`, move the notes under `[Unreleased]` into a new heading for that version and date, and update the links at the bottom.
3. Set the version, check, commit, and tag:

   ```bash
   npm version 0.2.0 --no-git-tag-version --ignore-scripts
   npm test && npm run typecheck
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "Release 0.2.0"
   git tag -a v0.2.0 -m "memorise 0.2.0"
   ```

4. Publish the commit and tag, then create the GitHub release from that version's changelog notes:

   ```bash
   git push origin main v0.2.0
   gh release create v0.2.0 --title "memorise 0.2.0" --notes-file <notes file>
   ```
