/**
 * plan — Plan file management for pi-coding-agent
 *
 * Provides two tools:
 *   create_plan  — create a new .org plan file and attach it to the session
 *   edit_plan    — apply sequential text replacements to the active plan
 *
 * When a plan is active, its content is injected into the last user message
 * of each provider request whenever it has changed since the last injection.
 *
 * Plans live in <ctx.cwd>/.pi/plans/ (same root convention as pi itself).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEditToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { promises as fs } from "node:fs";
import path from "node:path";

// ── Module-level state ─────────────────────────────────────────────────────

/** Absolute path to the currently active plan file, or null if none. */
let currentPlanPath: string | null = null;

/**
 * The plan content as of the last injection into a provider payload.
 * null means "inject unconditionally on the next request".
 */
let lastInjectedPlanContent: string | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function defaultTemplate(title: string): string {
  return [
    `#+TITLE: ${title}`,
    `#+CREATED: [${isoDate()}]`,
    "",
    "* Goal",
    "",
    "* Tasks",
    "",
    "** TODO",
    "",
  ].join("\n");
}

/** Directory where plans are stored: <ctx.cwd>/.pi/plans/ */
function plansDir(cwd: string): string {
  return path.join(cwd, ".pi", "plans");
}

/**
 * Ensure the content starts with #+TITLE and #+CREATED org properties.
 * If either is already present anywhere in the file (e.g. the LLM included
 * them), it is left untouched. Missing ones are prepended so the file always
 * opens with both properties.
 */
function enforceOrgHeader(title: string, content: string): string {
  const hasTitle = /^#\+TITLE:/im.test(content);
  const hasCreated = /^#\+CREATED:/im.test(content);
  if (hasTitle && hasCreated) return content;

  const toAdd: string[] = [];
  if (!hasTitle) toAdd.push(`#+TITLE: ${title}`);
  if (!hasCreated) toAdd.push(`#+CREATED: [${isoDate()}]`);
  return toAdd.join("\n") + "\n" + content;
}

/**
 * Append text to the last user message in a provider payload.
 * Handles both Anthropic (content array) and OpenAI (content string) shapes.
 * Duplicated from the mode extension — both extensions are intentionally
 * independent with no shared imports.
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

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── create_plan tool ───────────────────────────────────────────────────
  pi.registerTool({
    name: "create_plan",
    label: "Create Plan",
    description:
      "Create a new org-mode plan file and attach it to the current session. " +
      "The plan will be injected into context on every subsequent turn. " +
      "Only one plan can be active at a time.",
    parameters: Type.Object({
      title: Type.String({
        description: "Human-readable plan title. Used for the filename and #+TITLE header.",
      }),
      content: Type.Optional(
        Type.String({
          description: "Full org-mode file content. Omit to use the default template.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (currentPlanPath !== null) {
        return {
          content: [{
            type: "text",
            text:
              `A plan is already active: ${path.basename(currentPlanPath)}. ` +
              `Use /plan clear to detach it before creating a new one.`,
          }],
          isError: true,
        };
      }

      const dir = plansDir(ctx.cwd);
      await fs.mkdir(dir, { recursive: true });

      const filename = `${isoDate()}-${slugify(params.title)}.org`;
      const absPath = path.join(dir, filename);
      const fileContent = enforceOrgHeader(
        params.title,
        params.content ?? defaultTemplate(params.title),
      );

      await fs.writeFile(absPath, fileContent, "utf-8");

      currentPlanPath = absPath;
      lastInjectedPlanContent = null; // trigger immediate injection on next turn
      pi.appendEntry("plan-state", { planFile: absPath });

      return {
        content: [{ type: "text", text: `Plan created: ${filename}.` }],
      };
    },
  });

  // ── edit_plan tool ────────────────────────────────────────────────────
  // Semantics are intentionally identical to pi's built-in edit tool
  // (uniqueness enforcement, fuzzy matching, line-ending normalisation, diff
  // output) — achieved by delegating to createEditToolDefinition internally.
  // The only differences: the file path is fixed (the active plan), and the
  // success response returns the full updated file content instead of the
  // built-in "Successfully replaced N block(s)" message.
  pi.registerTool({
    name: "edit_plan",
    label: "Edit Plan",
    description:
      "Apply one or more text replacements to the active plan file. " +
      "Behaves identically to the built-in edit tool: each oldText must be " +
      "unique in the file and edits must not overlap.",
    parameters: Type.Object({
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({
            description:
              "Exact text for one targeted replacement. " +
              "It must be unique in the file and must not overlap with any other edits[].oldText in the same call.",
          }),
          newText: Type.String({ description: "Replacement text for this targeted edit." }),
        }),
        {
          description:
            "One or more targeted replacements. Each edit is matched against " +
            "the original file, not incrementally.",
        },
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (currentPlanPath === null) {
        return {
          content: [{ type: "text", text: "No active plan. Use create_plan first." }],
          isError: true,
        };
      }

      const filename = path.basename(currentPlanPath);

      // Delegate to the built-in edit tool's engine.
      const editDef = createEditToolDefinition(ctx.cwd);
      const result = await editDef.execute(
        toolCallId,
        { path: currentPlanPath, edits: params.edits },
        signal,
        onUpdate,
        ctx,
      );

      if (result.isError) {
        // The built-in error messages include the absolute path — replace it
        // with just the filename to keep output consistent with the rest of
        // this extension. A bit ugly, but avoids re-implementing the engine.
        return {
          ...result,
          content: result.content.map((block) =>
            block.type === "text"
              ? { ...block, text: block.text.replaceAll(currentPlanPath!, filename) }
              : block,
          ),
        };
      }

      // On success: pass through the built-in result (success message + diff).
      // The full updated plan will be injected into context on the next turn
      // via before_provider_request — no need to duplicate it here.
      // lastInjectedPlanContent is intentionally NOT updated here.
      return {
        ...result,
        content: result.content.map((block) =>
          block.type === "text"
            ? { ...block, text: block.text.replaceAll(currentPlanPath!, filename) }
            : block,
        ),
      };
    },
  });

  // Further events and commands will be added in subsequent steps.
}
