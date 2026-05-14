/**
 * mode — Declarative mode system for pi-coding-agent
 *
 * Enforces operational modes by:
 * - Intercepting tool calls and blocking any tool not on the current mode's allowlist
 * - Injecting a <system-reminder> into the last user message before each provider
 *   request whenever the active mode has changed since the last injection
 *
 * Mode files live in ~/.pi/agent/modes/ (global) or .pi/modes/ (project-local).
 * Project-local files override global ones with the same id.
 */

import matter from "gray-matter";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

interface ModeDef {
  id: string;          // lowercased filename without .md
  name: string;        // display name
  color: string;       // theme colour key
  allowedTools: Set<string>;
  prompt: string;      // mode body, may be empty
  isDefault: boolean;  // true when frontmatter contains `default: true`
}

// ── Module-level state ─────────────────────────────────────────────────────

let modes: ModeDef[] = [];
let currentModeIndex = 0;
let lastInjectedModeId: string | null = null;
// Built once per session from modes[] — stable across turns, safe to put in system prompt.
let systemPromptAddition = "";

// ── Mode file loading ──────────────────────────────────────────────────────

function parseModeFile(filePath: string, rawContent: string): ModeDef | null {
  if (!rawContent.startsWith("---")) return null;

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawContent);
  } catch (e) {
    console.warn(`[mode] Failed to parse frontmatter in '${filePath}': ${e}`);
    return null;
  }

  const { data, content: body } = parsed;
  const id = path.basename(filePath, ".md").toLowerCase();
  const name =
    typeof data.name === "string" && data.name
      ? data.name
      : id.charAt(0).toUpperCase() + id.slice(1);
  const color = typeof data.color === "string" && data.color ? data.color : "accent";
  const rawTools = Array.isArray(data.tools) ? (data.tools as unknown[]) : [];
  const allowedTools = new Set<string>(
    rawTools.filter((t): t is string => typeof t === "string"),
  );
  const isDefault = data.default === true;

  return { id, name, color, allowedTools, prompt: body.trim(), isDefault };
}

async function loadModeDir(dir: string): Promise<ModeDef[]> {
  const result: ModeDef[] = [];
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(dir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const mode = parseModeFile(filePath, content);
        if (mode) {
          result.push(mode);
        } else {
          console.warn(
            `[mode] Skipping '${filePath}': missing or malformed frontmatter`,
          );
        }
      } catch {
        // Unreadable file — skip silently
      }
    }
  } catch {
    // Directory doesn't exist — not an error
  }
  return result;
}

async function loadModes(cwd: string): Promise<void> {
  const piAgentDir =
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const globalDir = path.join(piAgentDir, "modes");
  const localDir = path.join(cwd, ".pi", "modes");

  const [globalModes, localModes] = await Promise.all([
    loadModeDir(globalDir),
    loadModeDir(localDir),
  ]);

  // Validate: at most one default per scope.
  const globalDefaults = globalModes.filter((m) => m.isDefault);
  const localDefaults = localModes.filter((m) => m.isDefault);

  if (globalDefaults.length > 1) {
    console.error(
      `[mode] Multiple global modes have default:true ` +
        `(${globalDefaults.map((m) => m.id).join(", ")}). ` +
        `Ignoring all global defaults.`,
    );
    for (const m of globalDefaults) m.isDefault = false;
  }

  if (localDefaults.length > 1) {
    console.error(
      `[mode] Multiple project-local modes have default:true ` +
        `(${localDefaults.map((m) => m.id).join(", ")}). ` +
        `Ignoring all local defaults.`,
    );
    for (const m of localDefaults) m.isDefault = false;
  }

  // Merge: project-local overrides global by id (the local object replaces the global one).
  const merged = new Map<string, ModeDef>();
  for (const m of globalModes) merged.set(m.id, m);
  for (const m of localModes) {
    if (merged.has(m.id)) {
      console.warn(`[mode] Mode '${m.id}' overridden by project-local definition`);
    }
    merged.set(m.id, m);
  }

  // Resolve default conflicts after the merge.
  // The only multi-default scenario that is not an error:
  //   one global default + one local default with different ids (both survive merge).
  // In that case the local default wins — clear the global one.
  const localIds = new Set(localModes.map((m) => m.id));
  const mergedDefaults = [...merged.values()].filter((m) => m.isDefault);
  if (mergedDefaults.length > 1) {
    for (const m of mergedDefaults) {
      if (!localIds.has(m.id)) m.isDefault = false;
    }
  }

  if (merged.size === 0) {
    console.warn(
      "[mode] No mode files found in ~/.pi/agent/modes/ or .pi/modes/. " +
        "Installing built-in fallback mode. Copy examples/modes/*.md to ~/.pi/agent/modes/ to configure.",
    );
    modes = [
      {
        id: "agent",
        name: "Agent",
        color: "accent",
        allowedTools: new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]),
        prompt: "",
        isDefault: true,
      },
    ];
  } else {
    modes = [...merged.values()];
  }
  // Rebuild the static system-prompt block whenever modes are (re-)loaded.
  systemPromptAddition = buildSystemPromptAddition();
}

function findDefaultModeIndex(): number {
  // 1. Explicit default flag in frontmatter
  const explicit = modes.findIndex((m) => m.isDefault);
  if (explicit >= 0) return explicit;
  // 2. Mode whose id is "agent"
  const agent = modes.findIndex((m) => m.id === "agent");
  if (agent >= 0) return agent;
  // 3. First loaded mode
  return 0;
}

/**
 * Build the static block injected into the system prompt once per session.
 * Derived solely from modes[] which is stable for the lifetime of a session,
 * so the resulting string never changes between turns — no cache invalidation.
 */
function buildSystemPromptAddition(): string {
  const modeList = modes.map((m) => `  - ${m.id} (${m.name})`).join("\n");
  return [
    "<mode-info>",
    "Operational modes are active. Each mode restricts which tools you may call.",
    "",
    "Available modes:",
    modeList,
    "",
    "Commands: /mode → show current mode and allowed tools | /mode <id> → switch mode",
    "Shortcuts: Ctrl+Shift+L → next mode | Ctrl+Shift+H → previous mode",
    "",
    "If a tool call is rejected and the user seems confused, suggest running /mode",
    "to inspect restrictions or switching to a mode that allows the needed tool.",
    "</mode-info>",
  ].join("\n");
}

// ── Injection helpers ──────────────────────────────────────────────────────

/**
 * Append text to the last user message in a provider payload.
 * Handles both Anthropic (content array) and OpenAI (content string) shapes.
 */
function appendToLastUserMessage(payload: Record<string, unknown>, text: string): void {
  if (!Array.isArray(payload.messages)) return;
  const messages = payload.messages as Array<Record<string, unknown>>;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      msg.content = `${msg.content}\n\n${text}`;
    } else if (Array.isArray(msg.content)) {
      (msg.content as unknown[]).push({ type: "text", text });
    }
    break;
  }
}

function buildReminderText(mode: ModeDef): string {
  const toolList = [...mode.allowedTools].join(", ");
  const lines = [
    "<system-reminder>",
    `You are in ${mode.name} mode.`,
    "",
    `Available tools: ${toolList}`,
    "Calling any other tool will be rejected.",
  ];
  if (mode.prompt) {
    lines.push("", mode.prompt);
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

// ── Mode switch helper ─────────────────────────────────────────────────────

function updateModeStatus(ctx: ExtensionContext): void {
  if (modes.length === 0) return;
  const mode = modes[currentModeIndex];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const label = (ctx.ui.theme.fg as (c: string, t: string) => string)(mode.color, mode.name);
  ctx.ui.setStatus("mode", label);
}

function switchToMode(idx: number, pi: ExtensionAPI, ctx: ExtensionContext): void {
  currentModeIndex = idx;
  lastInjectedModeId = null;
  const mode = modes[idx];
  pi.appendEntry("mode-state", { modeId: mode.id });
  ctx.ui.notify(`Switched to ${mode.name} mode`, "info");
  updateModeStatus(ctx);
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── CLI flag ────────────────────────────────────────────────────────────
  pi.registerFlag("mode", {
    description: "Start in the specified mode (overrides persisted state)",
    type: "string",
  });

  // ── Session lifecycle ────────────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    // (Re-)load mode files on every session start so that project-local modes
    // are picked up when the CWD changes (e.g. fork to a different project).
    await loadModes(ctx.cwd);

    // Reset injection flag — always inject the reminder on the first turn.
    lastInjectedModeId = null;

    if (event.reason === "new") {
      // Fresh session: start at the default mode.
      currentModeIndex = findDefaultModeIndex();
    } else {
      // Restored/reloaded session: try to recover the last persisted mode.
      const entries = ctx.sessionManager.getEntries();
      let restored = false;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as {
          type: string;
          customType?: string;
          data?: { modeId?: string };
        };
        if (entry.type === "custom" && entry.customType === "mode-state") {
          const modeId = entry.data?.modeId;
          if (modeId) {
            const idx = modes.findIndex((m) => m.id === modeId);
            if (idx >= 0) {
              currentModeIndex = idx;
              restored = true;
            } else {
              // Persisted mode no longer exists (e.g. mode file was deleted).
              console.warn(
                `[mode] Persisted mode '${modeId}' not found; falling back to default.`,
              );
            }
          }
          break;
        }
      }
      if (!restored) {
        currentModeIndex = findDefaultModeIndex();
      }
    }

    // --mode flag overrides persisted/default state.
    const flagMode = pi.getFlag("mode") as string | undefined;
    if (flagMode) {
      const idx = modes.findIndex((m) => m.id === flagMode);
      if (idx >= 0) {
        currentModeIndex = idx;
      } else {
        ctx.ui.notify(`[mode] Unknown mode from --mode flag: '${flagMode}'`, "error");
      }
    }

    updateModeStatus(ctx);
  });

  pi.on("session_compact", async () => {
    lastInjectedModeId = null;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("mode", undefined);
  });

  // ── Static system-prompt injection ───────────────────────────────────────
  // Appends a stable <mode-info> block on every turn. The content is built
  // once from modes[] at session_start and never changes mid-session, so it
  // does not invalidate the provider's KV-tensor cache.
  pi.on("before_agent_start", async (event) => {
    if (!systemPromptAddition) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + systemPromptAddition };
  });

  // ── Tool call interception ───────────────────────────────────────────────
  pi.on("tool_call", async (event) => {
    if (modes.length === 0) return;
    const mode = modes[currentModeIndex];
    if (!mode.allowedTools.has(event.toolName)) {
      return {
        block: true,
        reason:
          `Tool '${event.toolName}' is not available in ${mode.name} mode. ` +
          `Available tools: ${[...mode.allowedTools].join(", ")}.`,
      };
    }
  });

  // ── Mode reminder injection ──────────────────────────────────────────────
  pi.on("before_provider_request", (event) => {
    if (modes.length === 0) return;
    const mode = modes[currentModeIndex];
    if (mode.id !== lastInjectedModeId) {
      appendToLastUserMessage(
        event.payload as Record<string, unknown>,
        buildReminderText(mode),
      );
      lastInjectedModeId = mode.id;
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────────
  pi.registerCommand("mode", {
    description: "Show current mode or switch to a named mode",
    getArgumentCompletions: (prefix: string) => {
      const items = modes.map((m) => ({ value: m.id, label: `${m.id} — ${m.name}` }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const target = args?.trim();

      if (!target) {
        const mode = modes[currentModeIndex];
        if (!mode) {
          ctx.ui.notify("[mode] No modes loaded.", "warning");
          return;
        }
        const toolList = [...mode.allowedTools].join(", ");
        ctx.ui.notify(`Current mode: ${mode.name}\nAvailable tools: ${toolList}`, "info");
        return;
      }

      const idx = modes.findIndex((m) => m.id === target);
      if (idx < 0) {
        const available = modes.map((m) => m.id).join(", ");
        ctx.ui.notify(
          `[mode] Unknown mode: '${target}'. Available: ${available}`,
          "error",
        );
        return;
      }

      switchToMode(idx, pi, ctx);
    },
  });

  // ── Shortcuts ─────────────────────────────────────────────────────────────
  pi.registerShortcut("ctrl+shift+l", {
    description: "Next mode",
    handler: async (ctx) => {
      if (modes.length === 0) return;
      const nextIdx = (currentModeIndex + 1) % modes.length;
      switchToMode(nextIdx, pi, ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+h", {
    description: "Previous mode",
    handler: async (ctx) => {
      if (modes.length === 0) return;
      const prevIdx = (currentModeIndex - 1 + modes.length) % modes.length;
      switchToMode(prevIdx, pi, ctx);
    },
  });
}
