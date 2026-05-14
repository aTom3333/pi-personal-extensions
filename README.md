# pi-personal-extensions

> **Note:** This project is primarily written by AI (Claude via
> [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)).
> The design, requirements, and review are by the human author.

A set of [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) extensions
for operational modes and plan management in pi.

## Install

```bash
pi install git:github.com/<user>/pi-personal-extensions
```

Both extensions are installed at once.

## Extensions

### mode

Declarative mode system. Controls which tools the LLM may use in a given mode
and injects a mode-specific system reminder on each turn.

### plan

Plan file management. Provides `create_plan` and `edit_plan` tools, tracks a
"current plan" as session state, and injects the plan's org content into context
whenever it changes.

## Setup

Copy the example mode files to `~/.pi/agent/modes/`:

```bash
cp examples/modes/*.md ~/.pi/agent/modes/
```

Edit the mode files to suit your workflow (add/remove tools, adjust prompts).

## Mode Files

Mode files live in `~/.pi/agent/modes/` (global) or `.pi/modes/` (project-local).
Project-local files override global ones with the same id.

```markdown
---
name: Plan
color: muted
tools:
  - read
  - grep
  - find
  - ls
  - edit_plan
  - create_plan
---
You are in planning mode. Explore the codebase read-only and produce or refine
a structured implementation plan using the create_plan / edit_plan tools.
Do not modify any source files.
```

### Frontmatter fields

| Field     | Description                                                             | Default              |
|-----------|-------------------------------------------------------------------------|----------------------|
| `name`    | Display name                                                            | Capitalised filename |
| `color`   | Border label colour: `accent` `warning` `muted` `success` `error` `dim` | `accent`            |
| `tools`   | Allowlist of tool names the LLM may call in this mode                   | (required)           |
| `default` | Set to `true` to make this the default mode for new sessions            | `false`              |

At most one global mode (`~/.pi/agent/modes/`) and one project-local mode (`.pi/modes/`)
may have `default: true`. If both are set, the project-local one wins (not an error).
If neither is set, the mode named `agent` is used; if there is no `agent` mode, the
first mode in load order becomes the default.

The body after the second `---` is the mode prompt injected as a system reminder.

## Commands & Shortcuts

| Action              | Command / Shortcut |
|---------------------|--------------------|
| Show current mode   | `/mode`            |
| Switch mode         | `/mode <id>`       |
| Next mode           | `Ctrl+Shift+L`     |
| Previous mode       | `Ctrl+Shift+H`     |
| Show current plan   | `/plan`            |
| Detach plan         | `/plan clear`      |
| Open plan in editor | `/plan open`       |

## CLI Flags

```bash
pi --mode ask     # start in ask mode
```
