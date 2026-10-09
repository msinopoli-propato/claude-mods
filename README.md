# claude-mods

Personal Claude Code mods, published as a plugin marketplace.

## Install

From a `claude` terminal session:

```
/plugin install turn-notify --marketplace msinopoli-propato/claude-mods
```

Answer `y` to add the marketplace and pick the **user** scope so the mod loads in every session (terminal and desktop Code tab).

## Mods

| Mod | What it does |
| --- | --- |
| `turn-notify` | Shows a toast and plays a sound when Claude finishes a turn longer than 10s, or when it needs your input (permission prompt, question, plan approval). Sound uses PowerShell, so it plays on Windows only. |
| `session-status` | Colored band above the prompt, e.g. `WI #8423 · ⎇ feature/issue-8423* · ⏱ 1.3h · 🤖 2 running · 3 done · ctx 42% (84k) · CPU 74% · RAM 76% · 61°C`. Shows the work item first (from the active run, else from `feature/issue-{ID}` branches or `<repo>-issue-{ID}` worktrees), the git branch (green when clean, yellow with `*` when dirty, bold red on `main`/`master`/`dev`/`desarrollo`/`UAT`), the run timer, a subagent tally for the session (running / done, plus failed when above zero; kept even after the engine drops finished agents; idle teammates are not counted), context usage (green < 60%, yellow < 85%, red above), and PC health as `CPU 27% · RAM 75% · 62°C` (refreshed every 20s through PowerShell, so Windows only; the segment is omitted when the read fails). It also times `/prosuite-comandos:*` runs: active time only (gaps over 10 minutes are excluded), shown as `⏱ 1.3h`, injected into the system prompt so the measured value can feed `CompletedWork`, and printed by `/wi-time`. It also sets the session title (desktop sidebar) to `WI #8423 · <work item title> · ctx 42%` when a work item is known: the title is read once per work item with `az boards work-item show` (requires the Azure CLI, logged in; Windows only) and cached in the plugin store; until it is cached, or if the lookup fails, the title omits it. The mod never writes to Azure DevOps. |

## Develop

```
claude plugin validate plugins/turn-notify
claude plugin test plugins/turn-notify
```
