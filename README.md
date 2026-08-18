# opencode-skill-usage

Minimal OpenCode plugin that counts completed Skill calls and provides no-LLM TUI/CLI statistics. No runtime dependencies.

Requires OpenCode 1.18.17–1.x.

## Install

```text
opencode plugin @t4lly/opencode-skill-usage -g
```

Restart OpenCode after installation.

## Configuration

```jsonc
{
  "plugin": [
    [
      "@t4lly/opencode-skill-usage",
      {
        "retentionDays": 30,
        "sessionCacheLimit": 256
      }
    ]
  ]
}
```

Defaults are `retentionDays: 30` and `sessionCacheLimit: 256`. Invalid values fall back to the defaults.

## `/skill-usage`

Shows Skill usage counts, including installed Skills with zero usage and retained history for removed Skills.

```text
Skill                  Calls
gitnexus-cli              184
processing-markdown       121
context7-cli               83
uiua                        0
old-skill [removed]         2
```

## `/skill-usage-agent`

Shows a Skill-by-Agent matrix.

```text
Skill           orchestrator  librarian  oracle
gitnexus-cli             42          0      18
context7-cli              2         31       1
uiua                      0          0       0
```

Both views are scrollable. Type in `Filter skills` to filter rows. Press uppercase `P` (`Shift+P`) to enter a period such as `1m`, `2h`, `1d`, `7d`, `30d`, or `all`.

## Storage

Logs are stored as daily JSONL files under OpenCode's state directory:

```text
<XDG_STATE_HOME or ~/.local/state>/opencode/skill-usage/
├─ 2026-08-17.jsonl
└─ 2026-08-18.jsonl
```

Each completed Skill call adds one record. `agent` is omitted when unavailable.

```json
{"ts":"2026-08-18T10:03:12.123Z","skill":"gitnexus-cli","agent":"orchestrator"}
```

Storage and retention cleanup are lazy. Logging failures never fail OpenCode or a Skill call.

## CLI

```text
opencode-skill-usage
opencode-skill-usage 2h
opencode-skill-usage 1d
opencode-skill-usage 7d
opencode-skill-usage 30d
opencode-skill-usage all
opencode-skill-usage 30d --json
```

The CLI defaults to 30 days. Use `--json` for JSON output.

## License

MIT
