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
- **Optionally suggests and cleans up.** Background agents can suggest memories from finished sessions and from a project's files, and suggest clean-ups (merging, rewriting, archiving). Nothing reaches an agent until you approve it.

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
paseo plugin add git:monarchmaisuriya/memorise --ref v0.8.0
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

- **Save a memory from the composer:** `/remember [--global] [preference|decision|gotcha|howto|reference:] <fact>`. Without `--global` it is saved for the workspace's project.
- **Manage everything from the sidebar:** the Memorise row in the sidebar header opens Memorise. Its left side lists **Global** and every project that has memories, an open Paseo workspace, or suggestions waiting, then **Suggestions**, **Needs attention**, and **Settings**. Show, hide, or move the row in Paseo's Settings > Sidebar. The Command Center has "Open Memorise for all projects" and "Open Memorise for this project".
  - **A project's memories:** search, plus **Filters** (show, kind, visibility, sort); active filters show as chips you can remove. **Select** turns on bulk actions (pin, turn on or off, archive, restore, delete). **Project settings** (or **Import and export** for Global) holds the project's switches and import and export. Each project also has a **Suggestions** tab with its suggestions, **Suggest from project files**, **Check memories against project files**, and **Suggest clean-ups**.
  - **Each memory:** its kind and any setting that changes what agents see, who saved it and when, and how agents used it. Then **Edit**, **Pin**, **Turn off**, and **More** (archive, make global or move to this project, history, delete). Archiving or moving shows **Undo**; deleting asks first. In the editor, **When agents see this** holds the files it is about, when it is shown, on or off, and an expiry date.
  - **Suggestions:** every project's suggestions in one place, one collapsible card per project (with **Approve all** and **Reject all** inside), **Expand all** / **Collapse all**, and **Clean up all projects** (those with at least 2 memories) at the top. Each suggestion says where it came from and when.
  - **Needs attention:** across Global and every project, the memories agents can't see (off, expired, or hidden after going unused) and those not used 14 days after they were saved.
  - **Settings:** the same settings as Settings > Plugins > Memorise, without leaving Memorise.
- **Work inside a workspace:** the Memorise workspace panel lists the project's memories and the global ones, with the same card and editor, and "Open in manager".
- **See what agents see:** the panel's **What agents see** tab shows exactly what a new agent started in that workspace would see, why each memory is listed (pinned, about files this workspace changed, global, or this project), and how much prompt space (lines and KB) it uses.
- **Review suggestions:** approve or reject them straight from the "memories suggested" card in the agent's chat, or edit them first in the Suggestions tab of the panel or Memorise. On desktop and in the browser, keys work there too: **j** and **k** (or the arrow keys) move between suggestions, **a** approves, and **r** rejects; keys typed into a field are left alone. In the cross-project Suggestions view, keys act on the open card while just one is open.
- **See memory use in chats:** each agent's chat gets one quiet line, such as "Memorise · 12 memories in this agent's prompt · opened 2, searched 1", that updates as the agent uses the memory tools. The model never sees it. Turn it off with "Show memory use in agent chats" in Settings.
- **Let agents do it:** agents search and read memory on their own, and save what they learn with the write tools.

### Words Memorise uses

The screens use plain words; the agents' tools and the files on disk keep their original names.

| On screen | Means | Agents' tool or internal name |
| --- | --- | --- |
| Project | A git repository (shared by its clones and worktrees) or a folder outside git | repo key |
| Global | Memories for every project | global scope |
| Archive / Restore | Hide a memory from agents and lists, and bring it back | `memory_retire`, status `retired` |
| Older version | A version replaced by an edit, kept in History | superseded |
| Suggestions | Memories and changes waiting for your review | proposals |
| Suggestions from sessions | Background agents read finished sessions and suggest memories | capture |
| Clean up | Suggest merging duplicates, rewriting unclear memories, archiving outdated ones | tidy |
| Suggest from project files / Check memories against project files | Read the README, docs, and build files and suggest memories, or fixes to saved ones | project scan (create / refresh) |
| Save suggestions without review | New suggested memories are saved straight away | auto-approve |
| Always / When matching files change / Title only / Only when searched | When agents see a memory | activation `listed` / `files` / `title` / `manual` |
| Expires on | After this day agents no longer see the memory | `until` |

### When agents see a memory

Set in the editor; agents can never change these.

| Setting | Values | Effect |
| --- | --- | --- |
| Show it to agents | Always (default), When matching files change, Title only, Only when searched | Always: ranked into every new agent's list. When matching files change: listed only when the workspace changed a file it is about (needs at least one file pattern). Title only: agents see the title and open the memory with `memory_read`. Only when searched: never listed, found only by `memory_search` |
| On for agents | on (default) / off | Off hides it from agents' lists, search, and reading without deleting it |
| Expires on | a date, or empty (default) | After that day (UTC) agents no longer see it; Memorise shows it as expired |

A pinned memory is always listed in full. Editing the title, text, kind, or files saves a new version (kept in History); changing when agents see it does not.

### Project settings

In **Project settings** or the panel's **What agents see** tab, shared by every clone and worktree of the project. Each switch applies at once:

- **Memory for this project:** off gives new agents here no memories and no memory tools.
- **Include global memories:** off keeps your global memories away from this project's agents (list, search, and reading).
- **Suggestions from sessions:** use the global setting, or turn suggestions from sessions on or off for this project only.
- **Save suggestions without review:** off by default. On, new memories suggested by sessions and project files are saved without waiting for you, marked "Saved without review", and hidden after going unused like an agent's. Rewrites, archives, and clean-ups still wait for you.

### Import and export

Export a project's (or Global's) current memories as Markdown, one `- [kind] title: text` line each, or as JSON, which keeps files and visibility settings. Import either, or the `[date] - text` lines that assistant memory exports produce. Every entry passes the same checks as a memory you save (length, no secrets); duplicates are skipped and named, and **Preview import** shows what would be added before anything is saved.

## Settings

Settings > Plugins > Memorise, or **Settings** in Memorise. The main level holds what most people change; **Advanced** holds limits, timing, models, and the tools port.

| Setting | Default | Notes |
| --- | --- | --- |
| Give agents memory | on | Off keeps saved memories |
| Read memories without asking | on | Saving or changing a memory still asks, unless the agent runs in a mode that skips approvals |
| Show memory use in agent chats | on | One line per agent: memories in its prompt, and how it used them |
| Suggest memories from sessions | off | See below |
| Provider that reads sessions | Same as the session | So no transcript leaves the provider that ran it |
| Clean up each project weekly | off | Checked when the plugin starts and hourly after; clean-ups can also be started by hand |
| Suggest from project files automatically | off | Once per project, or once then check weekly; see below |
| Advanced: Clean-up and project files provider | Claude | |
| Advanced: Memories in each new agent's prompt | 150 | 0 lists none (agents still get the tools); up to 400. The list is also capped at 8 KB |
| Advanced: Hide unused agent memories after (days) | 60 | 0 never hides them. Memories you saved or pinned are never hidden |
| Advanced: Wait after a session goes quiet (minutes) | 20 | 5 to 240; a new message restarts the wait |
| Advanced: Messages needed before suggesting | 3 | 1 to 50, counted since that session's last suggestions |
| Advanced: Background runs per day | 10 | 1 to 100; shared by session suggestions, clean-ups, and project files; each run is one model call |
| Advanced: Session model / Clean-up and project files model | empty | Empty uses the provider's default model; the session model applies only when one provider reads every session |
| Advanced: What to suggest / What never to suggest | empty | Optional guidance, up to 2,000 characters each |
| Advanced: Memory tools port | 6790 | Applies after the plugin reloads |

With no model set, a provider's default model is used, which for Claude is its largest model. Set a smaller model with a fixed provider to keep suggestions cheap.

## How it works

```
agent created in a workspace
        |
        v
plugin finds the repo key from the origin remote   e.g. github.com/acme/api
  (a folder outside git: its recorded key)          e.g. folder/notes-3f9a1c2b7d4e
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

A folder outside git is a project of its own, under a key such as `folder/notes-3f9a1c2b7d4e` that it gets the first time Memorise sees it. It has everything a repository has: memories, agent tools, the manager and panel, capture, tidy, project scans, auto-approve, switches, and import and export.

- **Renamed or moved:** the key is recorded in `folders.json` in the plugin's data, so a folder renamed or moved on the same disk keeps its key and memories; the manager shows its current name. A copy, or a move to another disk, is a new project (export and import carry memories over).
- **Subfolders:** the folder of a Paseo project outside git is a project root, and an agent started in a folder below it gets that project's memories, unless that subfolder already has memories or proposals of its own. A folder where an agent merely ran claims nothing below it, and your home folder and the filesystem root are never project roots.
- **Which folder is which:** a folder is recognised by its identity on disk first, so two folders that swap names keep their own memories. A new folder made at a path another folder used to have gets a key of its own; the old folder's memories stay listed in the manager.
- **Ranking:** with no git history, the files changed in the last 7 days stand in for the files a checkout changed (hidden, build, and dependency folders are skipped; the walk stops at 20,000 entries, 2,000 files, or 300 ms).
- **Citations:** pinned to the cited file's content instead of a commit; the memory is marked "needs check" when the file changes or goes.

## Suggestions from sessions, clean-ups, and project files

Suggestions from sessions and weekly clean-ups are off until you turn them on; clean-ups and suggestions from project files can also be started by hand.

- **Suggestions from sessions:** when a session has been quiet for a while, a background agent reads a summary of what happened since the last run and suggests memories. The summary holds your messages, the agent's replies, commands with exit codes, and files touched. Secret-shaped text is replaced before it is sent; reasoning and tool output are left out.
- **Clean up:** suggests merging duplicates, rewording unclear memories, and archiving outdated ones. It reads only the project's saved memories.
- **Suggest from project files:** suggests memories from the project's own files; **Check memories against project files** also suggests rewriting or archiving saved memories those files contradict. Memorise itself reads a fixed list from the repository root: the README, the contributing guide, up to 8 `docs/*.md`, `package.json` (name, scripts, engines, package manager, workspaces), `Makefile`, `justfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.tool-versions`, and `.nvmrc`. Each file is cut at 8 KB and all of them at 64 KB (the instruction files and build files first), symlinks, hard links, and binary files are skipped, and secret-shaped text is replaced. `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` are sent only so the scan leaves out what agents already read. From the manager, a scan reads a checkout of that repository that is open as a Paseo workspace. In a folder outside git, the scan reads the folder itself.
- **Automatic project files suggestions:** with "Suggest from project files automatically" set to **Once per project**, every project with an open Paseo workspace (git or not) is read once; **Once, then check weekly** also checks it a week after the last time. Scans start when a workspace is created, when the plugin starts, and hourly, one at a time. These automatic runs stop for the day once background runs reach half the daily limit, which leaves the rest for session suggestions and for runs you start. A first run that fails is tried again a day later. A run you started by hand counts; a project with memory off, or with suggestions from sessions turned off for it, is skipped; the plugin's own worker folder is never read. The results are suggestions, saved straight away only where the project saves suggestions without review.

The background agents read text that may contain instructions planted in a session, so their tools are switched off and every permission request they make is denied:

- **Claude:** every built-in tool and Paseo's own tools are disallowed, and your own MCP servers are not loaded.
- **OpenCode:** one rule denies every tool. OpenCode's free models refuse background agents, so capture there needs a paid model.
- **Codex:** cannot switch off its shell. Its workers run in a read-only sandbox with no network and no web search. A misled Codex worker could still read files and put what it read into a proposal, which you see before approving.

Workers run in the plugin's empty worker folder, inside one hidden Paseo workspace ("Memorise background work") that is made once and kept, and each worker is archived when it finishes. Paseo shows a project in the sidebar once its last workspace is archived, so the hidden workspace is never archived; if you archive it, the next worker makes it again.

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
