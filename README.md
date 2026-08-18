# opencode-skill-usage

Minimal OpenCode plugin for counting Skill usage.

- Server target records completed `skill` tool executions.
- TUI target provides instant `/skill-usage` and `/skill-usage-agent` commands without an LLM call.
- Optional CLI provides standalone statistics.
- No runtime dependencies, network calls, child processes, system-prompt injection, or startup I/O.

Requires OpenCode 1.18.17–1.x for the TUI plugin API used by `/skill-usage`.

## Install

Use OpenCode's official plugin installer. It installs the package and updates the required OpenCode configuration.

### npm

```text
opencode plugin @t4lly/opencode-skill-usage -g
```

### Local checkout

For development from a local checkout:

```text
opencode plugin file:///E:/Git/opencode-skill-usage -g -f
```

`-g` installs into the global OpenCode configuration. `-f` replaces an existing registration and is useful while iterating on a local checkout.

Restart OpenCode after installation.

The package declares a default server option of `retentionDays: 30`.

To change retention after installation, change the server plugin entry in `opencode.jsonc`:

```jsonc
{
  "plugin": [
    [
      "@t4lly/opencode-skill-usage",
      { "retentionDays": 60 }
    ]
  ]
}
```

For a local checkout, use the same options with the local plugin spec:

```jsonc
{
  "plugin": [
    [
      "file:///E:/Git/opencode-skill-usage",
      { "retentionDays": 60 }
    ]
  ]
}
```

The plain string form uses the default 30 days. `retentionDays` must be a positive integer; invalid values fall back to 30.

The TUI target does not need `retentionDays`; it only reads retained logs.

## `/skill-usage`

Type `/skill` and select `/skill-usage` from the TUI suggestions.

`/skill-usage` is a TUI command. It runs plugin code directly and does not send a prompt to the AI.

It displays currently discovered Skills, including zero-use Skills, plus retained history for removed Skills:

```text
Skill                  Calls
gitnexus-cli              184
processing-markdown       121
context7-cli               83
uiua                        0
old-skill [removed]         2
```

## `/skill-usage-agent`

`/skill-usage-agent` shows a Skill-by-Agent matrix. It is also a direct TUI command and does not call an LLM.

```text
Skill           orchestrator  librarian  oracle
gitnexus-cli             42          0      18
context7-cli              2         31       1
uiua                      0          0       0
```

Both TUI views are scrollable. The `Filter skills` field filters rows by Skill name. Press uppercase `P` (`Shift+P`) to open a separate period prompt, then enter `1m`, `2h`, `1d`, `7d`, `30d`, or `all`. The current period is shown in the dialog title. Period changes are view-local and reset to `all` when the command is opened again.

For scripted or non-interactive queries, use the optional CLI.

## Storage

Logs live in OpenCode's state area:

```text
<XDG_STATE_HOME or ~/.local/state>/opencode/skill-usage/
├─ 2026-08-17.jsonl
└─ 2026-08-18.jsonl
```

Each line is one completed Skill load. `agent` is additive and omitted when it cannot be determined:

```json
{"ts":"2026-08-18T10:03:12.123Z","skill":"gitnexus-cli","agent":"orchestrator"}
```

Storage is created lazily after the first recorded Skill call. Retention cleanup also runs lazily on the first recorded Skill call and at most once per day afterward.

Logging and cleanup errors are isolated so telemetry cannot fail a Skill call or prevent OpenCode from starting.

## CLI

The CLI is optional:

```text
opencode-skill-usage
opencode-skill-usage 7
opencode-skill-usage 7d
opencode-skill-usage 30
opencode-skill-usage all
opencode-skill-usage 30 --json
```

The query period defaults to 30 days. JSON output is available with `--json`.

## Roadmap

Keep the logger small and add breakdowns only when they are useful in practice.

- Usage by project.

The current JSONL schema is intentionally simple; future fields can be added without changing existing `ts` and `skill` records.

## Development

```text
npm run check
npm test
npm pack --dry-run
```

## Why it is built this way

These choices are intentional and are worth preserving when the plugin evolves:

- **One package, two OpenCode targets.** The server runtime can observe tools, while the TUI runtime can register an immediate `slashName` command. They are separate entrypoints because OpenCode treats them as separate plugin runtimes.
- **Use `opencode plugin` for installation.** The package declares `./server` and `./tui`; OpenCode's installer is responsible for registering each target in the correct configuration. The plugin should not rewrite OpenCode config itself.
- **Do not implement `/skill-usage` as a custom/prompt command.** That path invokes the agent/LLM. The TUI keymap command executes `run()` directly, so viewing statistics costs no model call.
- **No startup I/O or SDK self-calls.** OpenCode awaits plugin activation while it is starting. Storage work is therefore deferred until the first completed Skill call so telemetry cannot make OpenCode startup depend on storage or a not-yet-ready OpenCode service.
- **State storage, not config/project storage.** Usage history belongs under OpenCode's state area rather than `~/.config/opencode` or `.opencode`. This avoids mixing mutable telemetry with configuration or repository files.
- **Daily append-only JSONL.** Recording is an append; retention removes whole expired day files. This avoids rewriting a shared log while another OpenCode process may be appending to it.
- **Telemetry is fail-open.** Logging/pruning failures are isolated from Skill execution. Statistics must never break the work being measured.
- **Bound transient correlation state.** Agent attribution uses a small session-to-agent cache populated by `chat.params`. `session.idle`/`session.deleted` remove entries, `dispose` clears it, and a 1024-entry recent-session cap prevents unbounded growth even if lifecycle events are missed.
- **Keep the event schema additive.** Agent is optional and existing `ts`/`skill` records remain valid. Future fields should follow the same rule.

## Design constraints

- Server and TUI are separate plugin entrypoints.
- Installation is delegated to OpenCode's official `opencode plugin` command.
- Startup path does no I/O and calls no OpenCode SDK methods.
- `/skill-usage` uses the TUI keymap API, not a prompt command.
- No system prompt injection.
- No custom AI tool.
- No network access from plugin logic.
- No child processes from plugin logic.
- No separate settings file.
- Telemetry failures never fail OpenCode or a Skill call.

## License

MIT
