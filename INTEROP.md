# Memorise interop, version 1

Paseo plugins cannot call each other, so Memorise publishes a few files that other plugins on the same daemon may read or write. This page is the contract. A breaking change gets a new folder (`v2`), never an edit to `v1`.

Everything lives under `<PASEO_HOME>/plugin-data/memorise/interop/v1/`. Memorise always uses this folder, whatever id it was installed under.

## status.json (read)

```json
{ "version": 1, "plugin": "memorise", "writtenAt": "2026-10-29T12:00:00.000Z" }
```

Memorise rewrites it every 2 minutes while it runs. Treat Memorise as available when `version` is 1 and `writtenAt` is less than 10 minutes old (5 missed writes). Files are replaced atomically (write, then rename), so a reader never sees half a file.

## export/&lt;project key&gt;.json (read)

One file per project, for example `export/github.com/acme/api.json`. The project key is the repository's origin remote as `host/owner/repo`, `local/<hash>` for a repository without an origin, or `folder/<name>-<hash>` outside git.

```json
{
  "version": 1,
  "repoKey": "github.com/acme/api",
  "writtenAt": "2026-10-29T12:00:00.000Z",
  "memories": [
    {
      "id": "01JB8Z6X3T5Q9V2M4N7P8R1S0W",
      "type": "gotcha",
      "subject": "item refs",
      "status": "active",
      "enabled": true,
      "paths": ["shared/**"],
      "citations": [{ "path": "shared/contracts.ts", "lines": "40-52", "commit": "3f2a1c9" }]
    }
  ]
}
```

- Project memories only; global memories are left out.
- Current versions only; replaced versions are left out.
- No memory text. An agent reads a memory's text with Memorise's own `memory_read` tool, so Memorise's rules on reading still apply.
- Rewritten on the heartbeat when the project's memories changed.

## inbox/&lt;project key&gt;/&lt;any name&gt;.json (write)

A plugin may suggest replacing or archiving one existing memory of a project:

```json
{
  "version": 1,
  "from": "contextualise",
  "kind": "retire",
  "targets": ["01JB8Z6X3T5Q9V2M4N7P8R1S0W"],
  "reason": "Cites parseItemRef in shared/contracts.ts, removed at 9c1d2e3."
}
```

- `from`: your plugin id (lowercase letters, digits, and dashes).
- `kind`: `replace` or `retire`. Plugins cannot suggest new memories.
- `targets`: exactly one active memory id from the project's export.
- `subject`, `body`: for `replace`, at least one of them, with the same limits as a saved memory.
- `reason`: 1 to 300 characters. It is shown to the user, so put the evidence in it.
- No other fields. Write the file under a temporary name and rename it, or write it whole.

Memorise reads the inbox on start and every 2 minutes.

**Valid suggestions:**
- They go to Memorise's Suggestions, labelled "Suggested by <your plugin>".
- They always wait for the user, even in a project set to save suggestions without review.
- The inbox file is then removed.

**Repeats are ignored:** a suggestion already waiting, or one the user rejected before, is not filed again.

**Invalid files** are moved to `inbox-rejected/` with the reason, and logged. A file is invalid when:
- it does not match the schema above;
- its target is not an active memory of that project;
- it is larger than 16 KB;
- its text looks like a secret.

**Daily limit:** each project accepts at most 20 suggestions per day. Later files wait for the next day.
