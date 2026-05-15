/**
 * read-only-bash — OS-level read-only sandbox for bash commands
 *
 * Registers a `read_only_bash` tool that executes commands inside a bubblewrap
 * (bwrap) sandbox where the entire filesystem is bind-mounted read-only and
 * network access is fully blocked. Intended for ask/plan modes where the agent
 * should be able to explore the codebase but must not modify anything.
 *
 * Enforcement is done at the kernel level (Linux mount namespaces). No command
 * analysis is performed.
 *
 * Sandbox properties:
 * - Filesystem : read-only (--ro-bind / /)
 * - /tmp       : real host /tmp, visible read-only (repos cloned by fetch_content
 *                are accessible; write attempts fail with EROFS like any other path)
 * - Network    : blocked (--unshare-net)
 * - Lifetime   : sandbox is killed when the parent Node process dies (--die-with-parent)
 *
 * Platform support:
 * - Linux  : spawns `bwrap` directly (install: apt install bubblewrap)
 * - Windows: spawns `wsl -- bwrap ...` (requires WSL with bwrap installed inside;
 *            Windows paths are auto-converted to WSL paths for --chdir)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashToolDefinition, type BashOperations } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { Text } from "@mariozechner/pi-tui";

// ── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a Windows absolute path to its WSL /mnt/<drive>/... equivalent.
 *   C:\Users\thomas\project  →  /mnt/c/Users/thomas/project
 */
function toWslPath(winPath: string): string {
  return winPath
    .replace(/^([A-Za-z]):[\\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`)
    .replace(/\\/g, "/");
}

// ── Process tree kill ─────────────────────────────────────────────────────────

function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32") {
    // taskkill /F /T kills the process and all its children
    if (child.pid) {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "ignore",
        detached: true,
      });
    }
  } else {
    // Kill the entire process group (bwrap + sandboxed bash + any children)
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}

// ── Bwrap BashOperations ──────────────────────────────────────────────────────

function createBwrapOperations(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const isWindows = process.platform === "win32";

      // --chdir needs a Linux path inside the sandbox
      const sandboxCwd = isWindows ? toWslPath(cwd) : cwd;

      const bwrapArgs = [
        "--ro-bind", "/", "/",   // entire FS read-only (real /tmp included)
        "--proc", "/proc",       // procfs (ps, top, /proc/self/...)
        "--dev", "/dev",         // device nodes
        "--unshare-net",         // block all network access
        "--die-with-parent",     // sandbox dies if Node process dies
        "--chdir", sandboxCwd,   // preserve working directory
        "bash", "-c", command,
      ];

      // On Linux: bwrap directly. On Windows: delegate to WSL.
      const program = isWindows ? "wsl" : "bwrap";
      const args    = isWindows ? ["--", "bwrap", ...bwrapArgs] : bwrapArgs;

      return new Promise((resolve, reject) => {
        // Prepare environment with English locale forcing
        const execEnv = {
          ...(env ?? process.env),
          LANG: "en_US.UTF-8",
          LANGUAGE: "en",
        };

        const child = spawn(program, args, {
          cwd,
          // detached=true on Unix so we can kill the whole process group;
          // false on Windows (taskkill handles the tree instead)
          detached: process.platform !== "win32",
          // Forward env with English locale forcing
          env: execEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // ── Timeout ───────────────────────────────────────────────────────────
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeout * 1000);
        }

        // ── Abort signal ──────────────────────────────────────────────────────
        const onAbort = () => killTree(child);
        signal?.addEventListener("abort", onAbort, { once: true });

        // ── Output streaming ──────────────────────────────────────────────────
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        // ── Termination ───────────────────────────────────────────────────────
        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const baseDef = createBashToolDefinition(process.cwd(), {
    operations: createBwrapOperations(),
  });

  pi.registerTool({
    ...baseDef,
    name: "read_only_bash",
    label: "Bash (read-only)",
    renderCall(args, theme, context) {
      // Copied from createBashToolDefinition's renderCall with [ro] prefix added
      // to visually distinguish read-only-bash from regular bash in the chat.
      // Preserve the timing state that renderResult depends on
      const state = context.state;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const command = args.command ?? "";
      const timeoutSuffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      const commandDisplay = command
        ? command
        : theme.fg("toolOutput", "...");
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(
        theme.fg("muted", "[ro]") +
        theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) +
        timeoutSuffix,
      );
      return text;
    },
    description:
      "Execute bash commands in a read-only sandbox with forced English output. " +
      "The entire filesystem is mounted read-only at the OS level via bubblewrap " +
      "(Linux) or bubblewrap inside WSL (Windows) — no filesystem write can " +
      "succeed and network access is fully blocked. " +
      "The real /tmp is visible read-only, so repos cloned there by fetch_content " +
      "and similar tools are accessible via grep, find, cat, etc. " +
      "Use for exploration: ls, cat, grep, rg, find, git log, git diff, wc, head, tail, ...",
    promptSnippet:
      "Execute bash commands in an OS-level read-only sandbox (no writes, no network)",
  });
}
