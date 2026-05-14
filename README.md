# pi-personal-extensions

> **Note:** This project is primarily written by AI (Claude via
> [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)).
> The design, requirements, and review are by the human author.

A collection of independent [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent)
extensions. Each extension is self-contained and can be installed and used on its own —
there are no dependencies between them.

## Extensions

### mode

Declarative mode system. Controls which tools the LLM may use in a given mode
and injects a mode-specific system reminder on each turn.

### plan

Plan file management. Provides `create_plan` and `edit_plan` tools, tracks a
"current plan" as session state, and injects the plan's org content into context
whenever it changes.

### read-only-bash

Provides a `read_only_bash` tool: a bash shell sandboxed via
[bubblewrap](https://github.com/containers/bubblewrap) where the entire
filesystem is mounted read-only and network access is blocked at the OS level.
No command analysis — writes fail with `EROFS` regardless of the command.

See [`extensions/read-only-bash/README.md`](extensions/read-only-bash/README.md)
for setup instructions (Linux and Windows/WSL) and usage notes.

## Install

**All extensions at once:**

```bash
pi install git:github.com/aTom3333/pi-personal-extensions
```

**A single extension** — clone the repository and add the extension path to the
`extensions` array in `~/.pi/agent/settings.json`:

```bash
git clone https://github.com/aTom3333/pi-personal-extensions.git ~/pi-personal-extensions
```

```json
{
  "extensions": [
    "/home/you/pi-personal-extensions/extensions/read-only-bash"
  ]
}
```

Replace `read-only-bash` with whichever extension(s) you want.

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

## Load Order

The `mode` extension short-circuits `tool_call` chains on block. For this to
work correctly with permission-gating extensions (those that confirm dangerous
tool calls), `mode` must appear **first** in your `packages` list in
`~/.pi/agent/settings.json`. See `extensions/mode/DESIGN.md` for details.
