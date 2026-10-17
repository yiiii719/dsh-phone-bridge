"use strict";
/**
 * Configuration for the 微信连接 (WeChat Connect) DSH plugin.
 *
 * Values arrive from the plugin's `config:` block in the profile's
 * cordis.patch.yml, with environment overrides for one-off runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const SANDBOX_VALUES = ["read-only", "workspace-write", "danger-full-access"];

function defaultConfig() {
  return {
    // Start the long-poll bridge as soon as the profile boots.
    enabled: true,
    baseUrl: DEFAULT_BASE_URL,
    token: "",
    accountId: "",
    // Empty or "*" accepts every sender; otherwise a comma-separated allow list.
    // Keep it set to your own WeChat id: this bridge is for talking to your own
    // bot, and the allow list is what keeps strangers out.
    allowFrom: "",
    // Standing instructions prepended to every task: who the bot is, how it
    // should behave, and what it must not decide on the owner's behalf.
    instructions: "",
    routeTag: "",
    // The single working directory the conversation runs in. One owner, one
    // conversation, one workspace — no per-contact subdirectories.
    workDir: "",
    // Which DSH profile answers WeChat messages.
    sessionProfile: "headless",
    model: "",
    // Optional explicit DSH host executable and cli.js paths.
    dshHostExe: "",
    dshCliPath: "",
    longPollTimeoutMs: 35000,
    maxReplyChars: 3800,
    maxInboundAgeMs: 5 * 60 * 1000,
    // Inbound images/files: download them into a local directory and hand the
    // path to DSH instead of dropping the message.
    downloadMedia: true,
    incomingDir: "",
    maxMediaBytes: 20 * 1024 * 1024,
    mediaTimeoutMs: 60000,
    // Outbound media: let the model hand files back to the chat.
    sendMedia: true,
    cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
    maxSendBytes: 20 * 1024 * 1024,
    replyFooter: true,
    stateFile: "",
    logFile: "",
    logLevel: "info",
    // Daily digest: run `prompt` at `time` (server local time) and push the
    // answer — text plus any [[send:...]] attachments — to the owner. The owner
    // must have messaged the bot once, because the gateway requires a
    // context_token for anything the bot sends first.
    schedule: {
      enabled: false,
      time: "06:00",
      prompt: "",
      runOnStart: false,
    },
  };
}

/** Coerce the schedule block; bad values fall back to something harmless. */
function normalizeSchedule(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const time = String(value.time ?? "06:00").trim();
  return {
    enabled: value.enabled === true,
    time: /^([01]?\d|2[0-3]):([0-5]\d)$/.test(time) ? time : "06:00",
    prompt: String(value.prompt ?? "").trim(),
    runOnStart: value.runOnStart === true,
  };
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  return trimmed === "" ? DEFAULT_BASE_URL : trimmed;
}

function normalizeSandbox(value) {
  const trimmed = String(value ?? "").trim();
  return SANDBOX_VALUES.includes(trimmed) ? trimmed : "read-only";
}

function normalizeConfig(raw, { home } = {}) {
  const base = defaultConfig();
  const merged = { ...base, ...(raw ?? {}) };
  const clampInt = (value, fallback, min, max) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };
  const resolve = (value, fallback) => {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    if (text === "~") return os.homedir();
    if (text.startsWith("~/") || text.startsWith("~\\")) {
      return path.join(os.homedir(), text.slice(2));
    }
    return path.resolve(text);
  };

  const stateDir = home ? path.join(home, "wechat-connect") : path.join(os.homedir(), ".wechat-connect");
  const workDir = resolve(merged.workDir, process.cwd());

  return {
    ...merged,
    enabled: merged.enabled !== false,
    baseUrl: normalizeBaseUrl(merged.baseUrl),
    token: String(merged.token ?? "").trim(),
    accountId: String(merged.accountId ?? "").trim(),
    allowFrom: String(merged.allowFrom ?? "").trim(),
    instructions: String(merged.instructions ?? "").trim(),
    routeTag: String(merged.routeTag ?? "").trim(),
    workDir,
    sessionProfile: String(merged.sessionProfile ?? "").trim() || "headless",
    model: String(merged.model ?? "").trim(),
    dshHostExe: String(merged.dshHostExe ?? "").trim(),
    dshCliPath: String(merged.dshCliPath ?? "").trim(),
    longPollTimeoutMs: clampInt(merged.longPollTimeoutMs, base.longPollTimeoutMs, 1000, 60000),
    maxReplyChars: clampInt(merged.maxReplyChars, base.maxReplyChars, 1, 50000),
    maxInboundAgeMs: clampInt(merged.maxInboundAgeMs, base.maxInboundAgeMs, 0, 24 * 3600 * 1000),
    downloadMedia: merged.downloadMedia !== false,
    incomingDir: resolve(merged.incomingDir, path.join(workDir, "incoming")),
    maxMediaBytes: clampInt(merged.maxMediaBytes, base.maxMediaBytes, 1024, 512 * 1024 * 1024),
    mediaTimeoutMs: clampInt(merged.mediaTimeoutMs, base.mediaTimeoutMs, 1000, 600000),
    sendMedia: merged.sendMedia !== false,
    cdnBaseUrl: normalizeBaseUrl(merged.cdnBaseUrl || base.cdnBaseUrl),
    maxSendBytes: clampInt(merged.maxSendBytes, base.maxSendBytes, 1024, 512 * 1024 * 1024),
    replyFooter: merged.replyFooter !== false,
    stateFile: resolve(merged.stateFile, path.join(stateDir, "state.json")),
    logFile: resolve(merged.logFile, path.join(stateDir, "bridge.log")),
    logLevel: String(merged.logLevel ?? "info").trim() || "info",
    schedule: normalizeSchedule(merged.schedule),
  };
}

/** Environment overrides win over the profile config, for one-off runs. */
function applyEnvOverrides(config) {
  const out = { ...config };
  if (process.env.WECHAT_CONNECT_TOKEN) out.token = process.env.WECHAT_CONNECT_TOKEN.trim();
  if (process.env.WECHAT_CONNECT_BASE_URL) out.baseUrl = normalizeBaseUrl(process.env.WECHAT_CONNECT_BASE_URL);
  if (process.env.WECHAT_CONNECT_ALLOW_FROM) out.allowFrom = process.env.WECHAT_CONNECT_ALLOW_FROM.trim();
  return out;
}

function loadConfig(raw, options) {
  return applyEnvOverrides(normalizeConfig(raw, options));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export {
  DEFAULT_BASE_URL,
  SANDBOX_VALUES,
  defaultConfig,
  normalizeConfig,
  normalizeBaseUrl,
  normalizeSandbox,
  applyEnvOverrides,
  loadConfig,
  readJson,
  writeJson,
};
