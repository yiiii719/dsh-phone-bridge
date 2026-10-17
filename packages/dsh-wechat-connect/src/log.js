/**
 * Small append-only logger for the bridge. Writes to a rolling file so a plugin
 * running inside a GUI process has somewhere durable to report what it did.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_BYTES = 2 * 1024 * 1024;

export function createLogger({ file, level = "info", echo = true } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let dirReady = false;

  const prepare = () => {
    if (!file) return false;
    if (!dirReady) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        dirReady = true;
      } catch {
        return false;
      }
    }
    return true;
  };

  const rotate = () => {
    try {
      if (!file) return;
      const stat = fs.statSync(file);
      if (stat.size < MAX_BYTES) return;
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* rotation is best-effort */
    }
  };

  const write = (levelName, message) => {
    if ((LEVELS[levelName] ?? LEVELS.info) > threshold) return;
    const line = `${new Date().toISOString()} ${levelName.toUpperCase().padEnd(5)} ${message}`;
    if (echo) {
      const sink = levelName === "error" || levelName === "warn" ? console.error : console.log;
      sink(`[wechat-connect] ${message}`);
    }
    if (!prepare()) return;
    try {
      rotate();
      fs.appendFileSync(file, `${line}\n`, "utf8");
    } catch {
      /* logging must never break the bridge */
    }
  };

  const logger = {
    file,
    error: (m) => write("error", m),
    warn: (m) => write("warn", m),
    info: (m) => write("info", m),
    debug: (m) => write("debug", m),
    child: (prefix) => ({
      error: (m) => write("error", `${prefix} ${m}`),
      warn: (m) => write("warn", `${prefix} ${m}`),
      info: (m) => write("info", `${prefix} ${m}`),
      debug: (m) => write("debug", `${prefix} ${m}`),
    }),
  };
  return logger;
}

export function defaultLogFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "wechat-connect", "bridge.log");
}
