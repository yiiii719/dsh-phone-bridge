"use strict";
/**
 * Runs one DSH turn per WeChat message.
 *
 * This is the DSH counterpart of Codex's `codex app-server` bridge. Instead of a
 * long-lived JSON-RPC server it drives the supported non-interactive entry
 * point, `dsh --profile <p> headless --json`, once per message and parses the
 * newline-delimited run events it emits:
 *
 *   {"type":"session","sessionId":"session-…","cwd":"…"}
 *   {"type":"text","text":"…"}                 incremental assistant text
 *   {"type":"status","phase":"step_end","usage":{…}}
 *   {"type":"final","text":"…"}                the answer
 *
 * `--session-id` resumes a persisted session, which is what gives each WeChat
 * peer its own continuing conversation.
 *
 * The prompt is written to stdin rather than passed as an argument: `dsh
 * headless -` reads the task from stdin, so arbitrary chat text never reaches a
 * command line and no shell is involved.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

class BridgeError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Locate the DSH host executable and its CLI entry.
 *
 * The plugin normally runs inside the DSH process, so `process.execPath` is
 * already the Electron host binary and the CLI lives beside it under
 * `resources/app.asar`. Explicit config or env always wins.
 */
function resolveDshHost({ dshHostExe = "", dshCliPath = "" } = {}) {
  const exe = dshHostExe || process.env.DSH_HOST_EXE || process.execPath || "";
  const cliCandidates = [];
  if (dshCliPath) cliCandidates.push({ path: dshCliPath, ok: fs.existsSync(dshCliPath) });
  if (process.env.DSH_CLI_PATH) {
    const p = process.env.DSH_CLI_PATH;
    cliCandidates.push({ path: p, ok: fs.existsSync(p) });
  }
  if (exe) {
    const root = path.dirname(exe);
    const asarRoot = path.join(root, "resources", "app.asar");
    const cliInAsar = path.join(
      asarRoot,
      "dsh",
      "node_modules",
      "@deepseek-ai",
      "dsh-desktop-host",
      "lib",
      "cli.js"
    );
    // A member path inside app.asar cannot be stat'ed by plain Node, so accept it
    // when either the member is visible (Electron) or the archive itself exists;
    // the Electron host resolves the member at load time.
    cliCandidates.push({ path: cliInAsar, ok: fs.existsSync(cliInAsar) || fs.existsSync(asarRoot) });
  }

  const chosen = cliCandidates.find((candidate) => candidate.ok);
  if (!exe || !fs.existsSync(exe)) {
    throw new BridgeError(
      `cannot find the DSH host executable (tried "${exe}"). ` +
        `Set "dshHostExe" in the plugin config to the full path of "DeepSeek Harness.exe".`
    );
  }
  if (!chosen) {
    throw new BridgeError(
      `cannot find the DSH CLI entry beside "${exe}". ` +
        `Set "dshCliPath" in the plugin config to the full path of ` +
        `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
    );
  }
  return { exe, cliPath: chosen.path };
}

/** Parse the NDJSON event stream, keeping only what the bridge needs. */
function createEventSink() {
  const state = {
    sessionId: "",
    cwd: "",
    chunks: [],
    finalText: "",
    usage: null,
    errors: [],
    raw: [],
  };

  const handle = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON lines are diagnostics; keep a bounded trace.
      if (state.raw.length < 50) state.raw.push(trimmed);
      return;
    }
    if (state.raw.length < 50) state.raw.push(trimmed);
    switch (event.type) {
      case "session":
        if (typeof event.sessionId === "string") state.sessionId = event.sessionId;
        if (typeof event.cwd === "string") state.cwd = event.cwd;
        break;
      case "text":
        if (typeof event.text === "string") state.chunks.push(event.text);
        break;
      case "status":
        if (event.usage && typeof event.usage === "object") state.usage = event.usage;
        if (event.phase === "turn_end" && event.reason && event.reason.kind && event.reason.kind !== "completed") {
          state.errors.push(`turn ended: ${event.reason.kind}${event.reason.message ? ` — ${event.reason.message}` : ""}`);
        }
        break;
      case "final":
        if (typeof event.text === "string") state.finalText = event.text;
        break;
      case "error":
        state.errors.push(String(event.message ?? event.text ?? JSON.stringify(event)));
        break;
      default:
        break;
    }
  };

  return { state, handle };
}

class DshSessionRunner {
  constructor(config, logger) {
    this.config = config;
    this.log = logger ?? (() => {});
    this.host = null;
    this.active = null;
  }

  #host() {
    if (!this.host) {
      this.host = resolveDshHost({
        dshHostExe: this.config.dshHostExe,
        dshCliPath: this.config.dshCliPath,
      });
      this.log(`dsh host resolved: ${this.host.exe} :: ${path.basename(this.host.cliPath)}`);
    }
    return this.host;
  }

  /** Report whether the host and CLI can be found, without running a turn. */
  probe() {
    try {
      const host = this.#host();
      return { ok: true, ...host };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Run one turn. Resolves with `{ sessionId, text, usage, resumed }`.
   * @param {string} prompt message text from WeChat
   * @param {string} [sessionId] previous session to resume
   */
  async runTurn(prompt, sessionId, { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, signal, cwd } = {}) {
    const host = this.#host();
    const resumed = Boolean(sessionId && String(sessionId).trim());
    // A session's workspace is its working directory, so one directory per
    // conversation keeps each peer's files — and its resumable session — apart.
    const turnCwd = cwd || this.config.workDir;

    const profileArgs = ["--profile", this.config.sessionProfile, "--json"];
    if (resumed) profileArgs.push("--session-id", String(sessionId).trim());
    profileArgs.push("-"); // read the task from stdin

    // Caller-supplied text is never placed on a command line: the message travels
    // on stdin and every argv element below comes from configuration. The host is
    // spawned directly, never through a shell, so no quoting or escaping is needed
    // even when the install path contains spaces.
    const child = spawn(host.exe, ["--expose-internals", host.cliPath, ...profileArgs], {
      cwd: turnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });

    this.active = child;
    const { state: sink, handle } = createEventSink();
    const stderrTail = [];
    let settled = false;

    const result = await new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onAbort);
        this.active = null;
        fn(value);
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(reject, new BridgeError(`DSH turn timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(reject, new BridgeError("DSH turn cancelled"));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener?.("abort", onAbort, { once: true });
      }

      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        let index;
        while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
          handle(stdoutBuffer.slice(0, index));
          stdoutBuffer = stdoutBuffer.slice(index + 1);
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          stderrTail.push(trimmed);
          if (stderrTail.length > 30) stderrTail.shift();
        }
      });

      child.on("error", (error) => {
        finish(reject, new BridgeError(`could not start DSH: ${error.message}`, { code: error.code }));
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim()) handle(stdoutBuffer);
        if (code !== 0) {
          const detail = sink.errors.length ? sink.errors.join("; ") : stderrTail.join("\n");
          finish(
            reject,
            new BridgeError(`DSH exited with code ${code}${detail ? `: ${detail}` : ""}`, {
              code,
              stderr: stderrTail.join("\n"),
            })
          );
          return;
        }
        const text = (sink.finalText || sink.chunks.join("")).trim();
        finish(resolve, {
          sessionId: sink.sessionId,
          text,
          usage: sink.usage,
          resumed,
          cwd: sink.cwd,
        });
      });

      // Feed the prompt on stdin and close it so the run starts.
      child.stdin.on("error", () => {
        /* the child may exit before we finish writing; the close handler decides */
      });
      child.stdin.end(prompt, "utf8");
    });

    return result;
  }

  /** Terminate any in-flight turn. */
  cancelActive() {
    const child = this.active;
    if (!child) return false;
    try {
      child.kill();
    } catch {
      return false;
    }
    return true;
  }
}

export {
  DshSessionRunner,
  BridgeError,
  resolveDshHost,
  createEventSink,
  DEFAULT_TURN_TIMEOUT_MS,
};
