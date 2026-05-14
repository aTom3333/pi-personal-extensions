# mode — Design Notes

> This document records the design decisions made when implementing mode.
> It is derived from the original `PLAN.org` specification.

## What this extension does

mode enforces operational modes on the LLM by:

1. **Blocking disallowed tool calls** — via the `tool_call` event hook.
2. **Injecting a mode reminder** — into the last user message before every
   provider request where the active mode has changed since the last injection.

### Load order matters for permission-gating extensions

pi runs `tool_call` handlers in **extension load order** and short-circuits on
the first `{ block: true }` return — subsequent handlers do not run.

This means: if a permission-gating extension (one that shows a confirmation
dialog on tool calls) loads *before* the mode extension, it will prompt the
user even for tools that mode would have blocked anyway.

To avoid this, ensure the mode extension is listed **before** any
permission-gating extensions in your `~/.pi/agent/settings.json` `packages`
array:

```json
{
  "packages": [
    "git:github.com/<user>/pi-personal-extensions#extensions/mode",
    "git:github.com/<user>/my-permission-extension"
  ]
}
```

pi processes packages in array order within each scope (global, then project),
so position in the array is the reliable way to control handler priority.

## Key design decisions

### Allowlist over blocklist

Modes declare which tools **are permitted**, not which are forbidden. Any tool
not on the list is implicitly blocked. This avoids silent permission escalation
when new tools are added by other extensions: a new tool starts blocked in all
existing modes until the user explicitly adds it to the relevant allowlist.

### Cache stability — never touch the system prompt or tool list

The provider payload's tool list and system prompt must never change mid-session.
Changing either invalidates the KV-tensor cache for the entire conversation history,
multiplying inference cost by the number of accumulated messages.

Consequences:
- `pi.setActiveTools()` is **never called** — all tools remain registered at all times.
- The `payload.system` field is **never modified**.
- Dynamic mode information (which mode is active, what tools are available) is
  injected into the **last user message** of the payload instead, as a
  `<system-reminder>` block.

### Injection is conditional and edge-triggered

The reminder is only appended when `currentMode.id !== lastInjectedModeId`. This
means it fires on the first turn of every session (because `lastInjectedModeId`
is reset to `null` on `session_start`) and whenever the mode changes, but not on
every turn. `lastInjectedModeId` is also reset to `null` on `session_compact`
because compaction may not preserve the prior mode context.

### A mode is always active

There is no "no mode" state. Even if no mode files are found, a built-in fallback
mode is installed. This simplifies the enforcement logic (no null checks for the
current mode) and ensures the LLM always receives a reminder about which tools
are available.

### Mode files are user config, not extension code

Mode files live in `~/.pi/agent/modes/` (global) or `.pi/modes/` (project-local).
The `examples/modes/` directory in this repository provides starting points but is
**never loaded automatically**. Users own their mode files and can add tools from
any extension — there is no compile-time coupling between mode files and extension
code.

### Project-local overrides global by id

When a mode file with the same filename (id) exists in both the global and
project-local directories, the project-local definition replaces the global one
entirely. The global definition is discarded for that id.

### Default mode resolution order

1. A mode with `default: true` in its frontmatter.
2. If none, the mode whose id is `"agent"` (filename `agent.md`).
3. If neither exists, the first mode in load order.

One global default and one project-local default with **different ids** is not
an error: the project-local one wins. Multiple defaults within the same scope
(both in `~/.pi/agent/modes/` or both in `.pi/modes/`) is an error and all
defaults in that scope are cleared.

### Extension independence

mode and plan share no imports or runtime coupling. The only
connection between them is that mode files may list `create_plan` and `edit_plan`
in their `tools` allowlists — plain strings with no code dependency.
