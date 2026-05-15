/**
 * force-english-bash — Override bash tool with English locale forcing
 *
 * Overrides the built-in `bash` tool to automatically inject locale environment
 * variables (LANG, LC_ALL, LANGUAGE) so commands output in English regardless of
 * system locale. This helps the agent parse command output reliably.
 *
 * The overridden tool:
 * - Has the same functionality as the original bash tool
 * - Forces English output for all commands
 * - Updates description to clarify it's for non-read-only operations
 *
 * Use read_only_bash for commands that should not modify the filesystem.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Override the bash tool with English locale forcing via spawnHook
  const baseDef = createBashToolDefinition(process.cwd(), {
    spawnHook: (context) => {
      // Inject English locale environment variables
      // TODO does that break normal env injection becasue it only happens if ens is null?
      return {
        ...context,
        env: {
          ...context.env,
          LANG: "en_US.UTF-8",
          LANGUAGE: "en",
        },
      };
    },
  });

  pi.registerTool({
    ...baseDef,
    name: "bash",
    label: "Bash",
    // TODO Having this note makes the extension no longer independant of each other
    description:
      "Execute bash commands. Output is forced to English for reliable parsing. " +
      "For read-only exploration, use read_only_bash instead.",
    promptSnippet:
      "Execute bash commands (modifies files; use read_only_bash for read-only operations)",
    promptGuidelines: [
      "Use bash for commands that modify files or system state.",
      "Use read_only_bash for safe exploration and queries.",
    ],
  });
}
