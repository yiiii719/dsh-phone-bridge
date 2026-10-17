/**
 * 微信连接 bridge service.
 *
 * Long-polls the WeChat ilink gateway and answers each inbound message with a
 * DSH turn. Each WeChat peer is bound to its own persisted DSH session, so a
 * conversation with one contact continues independently of every other contact
 * and of your own interactive sessions — the same model Codex++ used.
 */
import fs from "node:fs";
import path from "node:path";

import { readJson, writeJson } from "./config.js";
import {
  WeixinClient,
  GatewayError,
  messageText,
  messageMedia,
  isActionableMessage,
  dedupKey,
  isAllowedPeer,
} from "./ilink.js";
import { downloadMedia, uploadMediaToCdn, buildMediaItem } from "./media.js";
import { DshSessionRunner, BridgeError } from "./bridge.js";
import { ConnectState } from "./store.js";
import * as qr from "./qr.js";

const MAX_QR_POLLS = 150; // ~5 minutes at 2s intervals
const QR_POLL_INTERVAL_MS = 2000;

/**
 * A line the model can write to hand a local file back to the chat:
 * `[[send:/root/dsh-work/out/report.xlsx]]`. Stripped from the visible reply.
 */
const ATTACHMENT_MARKER = /\[\[\s*send\s*:\s*(\S[^\]\n]{0,299}?)\s*\]\]/gi;

/** How the model is told about the marker, appended to every task. */
const SEND_HINT =
  "[系统提示] 需要把服务器上的文件或图片发给用户时，在回复的最后单独一行写 [[send:/绝对路径]]；多个文件各写一行。这一行会被替换成真实附件、不会展示给用户。";

/** Split a reply into its visible text and the local files it asked to send. */
function extractAttachments(reply) {
  const attachments = [];
  const text = String(reply ?? "").replace(ATTACHMENT_MARKER, (_match, target) => {
    const value = String(target).trim().replace(/^`+|`+$/g, "");
    if (value) attachments.push(value);
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), attachments: [...new Set(attachments)] };
}

/** Credentials scanned from WeChat live beside the state, not in the profile YAML. */
export function credentialsPath(config) {
  return path.join(path.dirname(config.stateFile), "credentials.json");
}

export function loadCredentials(config) {
  return readJson(credentialsPath(config), null);
}

export function saveCredentials(config, credentials) {
  writeJson(credentialsPath(config), credentials);
}

/**
 * Merge scanned credentials over the profile config. Scanned values win, so a
 * profile never has to be hand-edited after a login.
 */
export function resolveCredentials(config) {
  const stored = loadCredentials(config);
  return {
    baseUrl: (stored?.baseUrl || config.baseUrl || "").trim() || config.baseUrl,
    token: (stored?.token || config.token || "").trim(),
    accountId: (stored?.accountId || config.accountId || "").trim(),
    ilinkUserId: (stored?.ilinkUserId || "").trim(),
    source: stored?.token ? "scanned" : config.token ? "config" : "none",
  };
}

/** Attribution line appended to every reply. */
export function appendFooter(reply, { workDir, usage }) {
  const window = Number(usage?.inputTokens ?? 0) + Number(usage?.cacheReadTokens ?? 0);
  const context = Number.isFinite(window) && window > 0 ? `ctx ~${Math.round(window / 1000)}k` : "ctx --";
  const dir = compactPath(workDir);
  return `${String(reply).trim()}\n\nDSH · ${context}\n${dir}`;
}

export function compactPath(target) {
  const resolved = path.resolve(target);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home && resolved.startsWith(home)) {
    const rest = resolved.slice(home.length).replace(/^[\\/]/, "");
    return rest ? `~/${rest.split(/[\\/]/).join("/")}` : "~";
  }
  return resolved.split(/[\\/]/).join("/");
}

export class WechatConnectService {
  constructor(config, logger) {
    this.config = config;
    this.log = logger;
    this.state = new ConnectState(config.stateFile);
    this.runner = new DshSessionRunner(config, (m) => this.log?.info(m));
    this.client = null;
    this.stopping = false;
    this.loop = null;
    this.digestTimer = null;
    this.restartTimer = null;
    this.supervising = false;
    this.restarts = 0;
    this.current = {
      state: "stopped",
      message: "微信连接未启动。",
      lastPeerId: "",
      lastMessageAtMs: 0,
      processedMessages: 0,
      lastError: "",
    };
  }

  get running() {
    return Boolean(this.loop) || this.supervising;
  }

  /**
   * A fresh-enough heartbeat file lets an external watchdog tell "alive but
   * wedged" from "working": the bridge writes it after every successful poll.
   */
  heartbeatPath() {
    return path.join(path.dirname(this.config.stateFile), "heartbeat.json");
  }

  #beat() {
    try {
      fs.writeFileSync(
        this.heartbeatPath(),
        JSON.stringify({
          at: Date.now(),
          atIso: new Date().toISOString(),
          pid: process.pid,
          restarts: this.restarts,
          accountId: resolveCredentials(this.config).accountId || "",
        })
      );
    } catch (error) {
      this.log?.debug(`could not write the heartbeat: ${error.message}`);
    }
  }

  /** A snapshot for tools and logs. */
  status() {
    const credentials = resolveCredentials(this.config);
    return {
      ...this.current,
      running: this.running,
      accountId: credentials.accountId,
      hasToken: Boolean(credentials.token),
      credentialSource: credentials.source,
      baseUrl: credentials.baseUrl,
      sessionProfile: this.config.sessionProfile,
      schedule: {
        enabled: Boolean(this.config.schedule?.enabled),
        time: this.config.schedule?.time ?? "",
        peers: this.config.schedule?.peers ?? [],
        runOnStart: Boolean(this.config.schedule?.runOnStart),
      },
      workDir: this.config.workDir,
      allowFrom: this.config.allowFrom || "* (everyone)",
      peers: Object.keys(this.state.data.threadIds),
      host: this.runner.probe(),
      credentialsFile: credentialsPath(this.config),
      stateFile: this.config.stateFile,
      logFile: this.config.logFile,
    };
  }

  #setStatus(state, message) {
    this.current.state = state;
    this.current.message = message;
    this.log?.debug(`status ${state}: ${message}`);
  }

  #clientOrThrow() {
    const credentials = resolveCredentials(this.config);
    if (!credentials.token) {
      throw new GatewayError('还没有登录微信。先在会话里运行 wechat_connect_login 扫码。');
    }
    if (!this.client || this.client.token !== credentials.token || this.client.baseUrl !== credentials.baseUrl) {
      this.client = new WeixinClient({
        baseUrl: credentials.baseUrl,
        token: credentials.token,
        routeTag: this.config.routeTag,
      });
    }
    return this.client;
  }

  // ---- login ---------------------------------------------------------------

  /**
   * Fetch a login QR code.
   * @returns {Promise<{qrcode:string, url:string, ascii:string}>}
   */
  async loginQr() {
    const credentials = resolveCredentials(this.config);
    const { qrcode, qrcodeImgContent } = await WeixinClient.fetchQrCode({
      baseUrl: credentials.baseUrl,
      routeTag: this.config.routeTag,
    });
    let ascii = "";
    try {
      ascii = qr.toTerminal(qr.encode(qrcodeImgContent, "M"));
    } catch (error) {
      this.log?.warn(`could not render the login QR code: ${error.message}`);
    }
    return { qrcode, url: qrcodeImgContent, ascii };
  }

  /** Poll until the QR code is confirmed, then persist the credentials. */
  async awaitLogin(qrcode, { onProgress } = {}) {
    const credentials = resolveCredentials(this.config);
    let last = "";
    for (let attempt = 0; attempt < MAX_QR_POLLS; attempt++) {
      if (this.stopping) throw new GatewayError("登录已取消");
      const status = await WeixinClient.pollQrStatus({
        baseUrl: credentials.baseUrl,
        routeTag: this.config.routeTag,
        qrcode,
      });
      if (status.status && status.status !== last) {
        last = status.status;
        onProgress?.(status.status);
        this.log?.info(`scan status: ${status.status}`);
      }
      if (status.status === "confirmed") {
        if (!status.botToken || !status.ilinkBotId) {
          throw new GatewayError("微信已确认登录，但网关没有返回完整凭据。请重新扫码。");
        }
        const saved = {
          baseUrl: (status.baseurl || credentials.baseUrl).trim(),
          token: status.botToken,
          accountId: status.ilinkBotId,
          ilinkUserId: status.ilinkUserId || "",
          savedAt: new Date().toISOString(),
        };
        saveCredentials(this.config, saved);
        this.client = null;
        this.log?.info(`login saved for account ${saved.accountId}`);
        return saved;
      }
      if (status.status === "expired") {
        throw new GatewayError("二维码已过期，请重新获取。");
      }
      await new Promise((resolve) => setTimeout(resolve, QR_POLL_INTERVAL_MS));
    }
    throw new GatewayError("等待扫码超时。");
  }

  // ---- lifecycle -----------------------------------------------------------

  start() {
    if (this.loop || this.supervising) return false;
    this.stopping = false;
    this.#supervise();
    this.#scheduleDigest();
    if (this.config.schedule?.runOnStart) {
      this.log?.info("schedule.runOnStart is on: running the digest once now");
      setTimeout(() => {
        this.runDigestNow({ reason: "runOnStart" }).catch((error) =>
          this.log?.error(`digest (runOnStart) failed: ${error.stack || error.message}`)
        );
      }, 5000);
    }
    return true;
  }

  /**
   * Supervise the long-poll loop: whatever ends it short of an explicit stop —
   * a thrown error, a missing work directory, a dead DSH host — is retried with
   * backoff, so the process never sits idle while the bridge is down.
   */
  #supervise() {
    this.supervising = true;
    this.#beat();
    this.loop = this.#run()
      .catch((error) => {
        this.current.lastError = error.message;
        this.#setStatus("error", `微信连接异常：${error.message}`);
        this.log?.error(`bridge loop failed: ${error.stack || error.message}`);
      })
      .finally(() => {
        this.loop = null;
        if (this.stopping) {
          this.supervising = false;
          return;
        }
        this.restarts += 1;
        const delay = Math.min(60000, 3000 * Math.min(this.restarts, 20));
        this.#setStatus("retrying", `桥接已退出，${Math.round(delay / 1000)} 秒后自动重启（第 ${this.restarts} 次）。`);
        this.log?.warn(`bridge loop ended without a stop request; restarting in ${Math.round(delay / 1000)}s (attempt ${this.restarts})`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping) this.#supervise();
          else this.supervising = false;
        }, delay);
      });
  }

  async stop() {
    this.stopping = true;
    this.#clearDigestTimer();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.supervising = false;
    this.runner.cancelActive();
    if (this.loop) {
      await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 5000))]);
      this.loop = null;
    }
    this.state.save();
    this.#setStatus("stopped", "微信连接已停止。");
  }

  /**
   * Interactive login for a bridge-only profile.
   *
   * A profile that just runs the bridge has no agent session, so no tool can be
   * called to fetch a QR code. Print it to the console and wait for the scan
   * instead, which makes `dsh --profile wechat` self-sufficient.
   */
  async #consoleLogin() {
    this.#setStatus("needs_login", "还没有登录微信，正在获取登录二维码…");
    let qrInfo;
    try {
      qrInfo = await this.loginQr();
    } catch (error) {
      this.log?.error(`could not fetch the login QR code: ${error.message}`);
      return false;
    }

    const banner = [
      "",
      "=".repeat(72),
      "  微信连接 · 用微信扫描下面的二维码完成登录",
      `  QR id: ${qrInfo.qrcode}`,
      `  链接:  ${qrInfo.url}`,
      "=".repeat(72),
      "",
      qrInfo.ascii,
      "",
      "等待扫码中（Ctrl+C 取消）…",
      "",
    ].join("\n");
    // Always show this on stdout: it is the only way to complete login here.
    process.stdout.write(`${banner}\n`);
    this.log?.info(`login QR issued (qrcode=${qrInfo.qrcode}); waiting for a scan`);

    try {
      const saved = await this.awaitLogin(qrInfo.qrcode, {
        onProgress: (status) => {
          process.stdout.write(`  扫码状态: ${status}\n`);
          this.log?.info(`scan status: ${status}`);
        },
      });
      process.stdout.write(`\n✅ 登录成功，账号 ${saved.accountId}。微信连接即将启动。\n\n`);
      this.log?.info(`login saved for account ${saved.accountId}`);
      return true;
    } catch (error) {
      process.stdout.write(`\n⚠️ 登录未完成：${error.message}\n\n`);
      this.log?.error(`login did not complete: ${error.message}`);
      return false;
    }
  }

  async #run() {
    let credentials = resolveCredentials(this.config);
    if (!credentials.token) {
      const ok = await this.#consoleLogin();
      if (!ok) {
        this.#setStatus(
          "needs_login",
          "还没有登录微信。重新启动本 profile 再扫一次码，或在带会话的 profile 里运行 wechat_connect_login。"
        );
        return;
      }
      credentials = resolveCredentials(this.config);
    }
    if (!fs.existsSync(this.config.workDir)) {
      this.#setStatus("error", `工作目录不存在：${this.config.workDir}`);
      return;
    }
    const host = this.runner.probe();
    if (!host.ok) {
      this.#setStatus("error", `找不到 DSH 宿主：${host.error}`);
      return;
    }

    this.#setStatus("running", "微信连接正在运行。");
    this.log?.info(`bridge started (account=${credentials.accountId || "unknown"}, profile=${this.config.sessionProfile})`);

    let longPollTimeoutMs = this.config.longPollTimeoutMs;

    while (!this.stopping) {
      let updates;
      try {
        updates = await this.#clientOrThrow().getUpdates(this.state.cursor, longPollTimeoutMs);
      } catch (error) {
        if (this.stopping) break;
        this.#setStatus("retrying", `微信长轮询失败，2 秒后重试：${error.message}`);
        this.log?.warn(`long poll failed: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      this.state.cursor = updates.cursor;
      if (updates.longPollingTimeoutMs) longPollTimeoutMs = updates.longPollingTimeoutMs;
      this.#beat();

      for (const message of updates.messages) {
        if (this.stopping) break;
        await this.#handleMessage(message);
      }
      this.state.save();
    }
  }

  /**
   * Build the task text for one inbound message.
   *
   * Text passes through untouched. Images and files are downloaded first and
   * appended as absolute local paths, because that is what the DSH turn can
   * open: `read_image` for pictures, the file tools for everything else.
   * @returns the task text, or null when nothing usable remains.
   */
  async #composeTask(text, media, conversationDir) {
    const lines = [];
    if (this.config.instructions) lines.push(this.config.instructions);
    if (text) lines.push(text);
    if (media.length === 0) {
      if (this.config.sendMedia && lines.length) lines.push(SEND_HINT);
      return lines.join("\n").trim() || null;
    }

    if (!this.config.downloadMedia) {
      for (const item of media) {
        lines.push(
          item.kind === "image"
            ? "[微信图片] 未下载（downloadMedia 已关闭）"
            : `[微信文件] ${item.name} 未下载（downloadMedia 已关闭）`
        );
      }
      return lines.join("\n").trim() || null;
    }

    for (const item of media) {
      try {
        const saved = await downloadMedia(item, {
          dir: this.config.perPeerDirs ? path.join(conversationDir, "incoming") : this.config.incomingDir,
          maxBytes: this.config.maxMediaBytes,
          timeoutMs: this.config.mediaTimeoutMs,
          log: (message) => this.log?.info(message),
        });
        const kb = Math.max(1, Math.round(saved.bytes / 1024));
        lines.push(
          item.kind === "image"
            ? `[微信图片] ${saved.path}（${kb} KB，可用 read_image 查看）`
            : `[微信文件] ${saved.path}（原名 ${saved.name}，${kb} KB）`
        );
      } catch (error) {
        this.log?.error(`media download failed (${item.kind}): ${error.message}`);
        lines.push(`[微信${item.kind === "image" ? "图片" : "文件"}] 下载失败：${error.message}`);
      }
    }
    if (this.config.sendMedia) lines.push(SEND_HINT);
    return lines.join("\n").trim() || null;
  }

  /**
   * One conversation, one folder: the peer's working directory under workDir.
   * A DSH session's workspace *is* its working directory, so giving each peer
   * its own folder keeps their files and resumable sessions apart.
   */
  #conversationDir(peer) {
    if (!this.config.perPeerDirs) return this.config.workDir;
    const safe =
      String(peer)
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[._-]+/, "")
        .slice(0, 80) || "peer";
    const dir = path.join(this.config.workDir, safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async #handleMessage(message) {
    const key = dedupKey(message);
    const peer = String(message?.from_user_id ?? "").trim();

    if (!isActionableMessage(message)) return;
    if (this.state.isProcessed(key)) return;
    if (Date.now() - Number(message.create_time_ms ?? 0) > this.config.maxInboundAgeMs) {
      this.state.markProcessed(key);
      return;
    }
    if (!isAllowedPeer(this.config.allowFrom, peer)) {
      this.#setStatus("running", `已忽略来自非白名单发送方的消息：${peer}`);
      this.log?.warn(`ignored message from non-allowed peer ${peer}`);
      this.state.markProcessed(key);
      return;
    }

    const text = messageText(message);
    const media = messageMedia(message);
    if (!text && media.length === 0) {
      this.log?.info(`ignored message without text or supported media from ${peer}`);
      this.state.markProcessed(key);
      return;
    }
    const contextToken = String(message.context_token ?? "").trim();
    if (!contextToken) {
      this.#setStatus("running", "收到缺少 context_token 的微信消息，已忽略。");
      this.state.markProcessed(key);
      return;
    }
    this.state.setContextToken(peer, contextToken);

    const conversationDir = this.#conversationDir(peer);

    // Images and files arrive as encrypted CDN links; fetch them first so the
    // turn sees local paths it can actually open.
    const task = await this.#composeTask(text, media, conversationDir);
    if (!task) {
      this.state.markProcessed(key);
      return;
    }

    this.#setStatus("running", `正在处理来自 ${peer} 的消息…`);
    this.log?.info(`message from ${peer}: ${task.slice(0, 160)}`);

    try {
      const { text: replyText, attachments } = await this.#answer(peer, task, conversationDir);
      if (replyText) {
        await this.#clientOrThrow().sendTextChunks({
          toUserId: peer,
          text: replyText,
          contextToken,
          maxChars: this.config.maxReplyChars,
        });
      }
      let sentAttachments = 0;
      for (const filePath of attachments) {
        try {
          await this.#sendAttachment(peer, contextToken, filePath);
          sentAttachments++;
        } catch (error) {
          this.log?.error(`could not send attachment ${filePath}: ${error.message}`);
          await this.#clientOrThrow().sendTextChunks({
            toUserId: peer,
            text: `附件发送失败（${filePath}）：${error.message}`.slice(0, 500),
            contextToken,
            maxChars: this.config.maxReplyChars,
          });
        }
      }
      this.state.markProcessed(key);
      this.state.noteHandled(peer);
      this.current.lastPeerId = peer;
      this.current.lastMessageAtMs = Date.now();
      this.current.processedMessages += 1;
      this.#setStatus("running", `已回复 ${peer}。`);
      this.log?.info(
        `replied to ${peer} (${replyText.length} chars${sentAttachments ? `, ${sentAttachments} attachment(s)` : ""})`
      );
    } catch (error) {
      this.state.markProcessed(key);
      this.current.lastError = error.message;
      this.#setStatus("retrying", `处理微信消息失败：${error.message}`);
      this.log?.error(`failed to answer ${peer}: ${error.stack || error.message}`);
      try {
        await this.#clientOrThrow().sendTextChunks({
          toUserId: peer,
          text: `DSH 处理失败：${error.message}`.slice(0, 500),
          contextToken,
          maxChars: this.config.maxReplyChars,
        });
      } catch (sendError) {
        this.log?.error(`could not send the failure notice: ${sendError.message}`);
      }
    }
    this.state.save();
  }

  // ---- scheduled digest ----------------------------------------------------

  #clearDigestTimer() {
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
  }

  /**
   * Arm a one-shot timer for the next occurrence of schedule.time (server local
   * time) and re-arm it after every run, so a long-running bridge keeps firing.
   */
  #scheduleDigest() {
    const schedule = this.config.schedule;
    this.#clearDigestTimer();
    if (!schedule?.enabled || !schedule.prompt) return;
    const [hours, minutes] = schedule.time.split(":").map((part) => Number.parseInt(part, 10));
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const delay = Math.max(1000, next.getTime() - Date.now());
    this.log?.info(
      `digest scheduled for ${next.toLocaleString()} (in ${Math.round(delay / 60000)} min) for ${
        (schedule.peers.length ? schedule.peers : Object.keys(this.state.data.threadIds)).join(", ") || "(no peer yet)"
      }`
    );
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      this.runDigestNow({ reason: "scheduled" })
        .catch((error) => this.log?.error(`digest failed: ${error.stack || error.message}`))
        .finally(() => this.#scheduleDigest());
    }, delay);
  }

  /**
   * Generate the configured digest with one DSH turn per peer and push it as a
   * WeChat message, plus any file the model handed back via [[send:...]].
   * @param {{reason?: string, peers?: string[]}} options
   */
  async runDigestNow({ reason = "manual", peers } = {}) {
    const schedule = this.config.schedule;
    const prompt = schedule?.prompt;
    if (!prompt) {
      this.log?.warn("digest requested but schedule.prompt is empty");
      return { sent: 0, skipped: 0, reason: "no prompt" };
    }
    // The gateway requires a context_token, so only peers that already messaged
    // the bot can receive a message the bot starts.
    const targets = (peers?.length ? peers : schedule.peers.length ? schedule.peers : Object.keys(this.state.data.threadIds))
      .filter((peer) => {
        if (this.state.contextTokenFor(peer)) return true;
        this.log?.warn(`digest skipped for ${peer}: no context_token yet (that peer never messaged the bot)`);
        return false;
      });
    if (!targets.length) {
      this.#setStatus("error", "定时早报：没有可发送的联系人（需要对方先给机器人发过消息）。");
      return { sent: 0, skipped: 0, reason: "no reachable peer" };
    }

    let sent = 0;
    for (const peer of targets) {
      if (this.stopping) break;
      const contextToken = this.state.contextTokenFor(peer);
      const conversationDir = this.#conversationDir(peer);
      const task = await this.#composeTask(prompt, [], conversationDir);
      if (!task) continue;
      this.#setStatus("running", `正在生成定时早报（${reason}）…`);
      this.log?.info(`digest run for ${peer} (${reason})`);
      try {
        const { text: replyText, attachments } = await this.#answer(peer, task, conversationDir);
        if (replyText) {
          await this.#clientOrThrow().sendTextChunks({
            toUserId: peer,
            text: replyText,
            contextToken,
            maxChars: this.config.maxReplyChars,
          });
        }
        let files = 0;
        for (const filePath of attachments) {
          try {
            await this.#sendAttachment(peer, contextToken, filePath);
            files++;
          } catch (error) {
            this.log?.error(`digest attachment failed (${filePath}): ${error.message}`);
            await this.#clientOrThrow().sendTextChunks({
              toUserId: peer,
              text: `早报附件发送失败（${filePath}）：${error.message}`.slice(0, 500),
              contextToken,
              maxChars: this.config.maxReplyChars,
            });
          }
        }
        this.state.noteHandled(peer);
        this.current.lastPeerId = peer;
        this.current.lastMessageAtMs = Date.now();
        this.#setStatus("running", `已发送定时早报给 ${peer}。`);
        this.log?.info(
          `digest sent to ${peer} (${replyText.length} chars, ${files} attachment(s))`
        );
        sent++;
      } catch (error) {
        this.current.lastError = error.message;
        this.#setStatus("retrying", `定时早报失败：${error.message}`);
        this.log?.error(`digest failed for ${peer}: ${error.stack || error.message}`);
        try {
          await this.#clientOrThrow().sendTextChunks({
            toUserId: peer,
            text: `早报生成失败：${error.message}`.slice(0, 500),
            contextToken,
            maxChars: this.config.maxReplyChars,
          });
        } catch (sendError) {
          this.log?.error(`could not report the digest failure: ${sendError.message}`);
        }
      }
      this.state.save();
    }
    return { sent, skipped: targets.length - sent, reason };
  }

  /** Run one DSH turn for the peer, resuming its session when one is stored. */
  async #answer(peer, text, conversationDir) {
    const cwd = conversationDir || this.config.workDir;
    const saved = this.state.threadIdFor(peer);
    let result;
    try {
      result = await this.runner.runTurn(text, saved, { cwd });
    } catch (error) {
      // A persisted session can disappear (deleted, or a different DSH home),
      // and a session recorded under another workspace cannot be resumed here.
      if (!saved || !(error instanceof BridgeError)) throw error;
      this.log?.warn(`resuming session ${saved} failed (${error.message}); starting a new one`);
      this.state.clearThreadId(peer);
      result = await this.runner.runTurn(text, undefined, { cwd });
    }
    if (result.sessionId && result.sessionId !== saved) {
      this.state.setThreadId(peer, result.sessionId);
    }
    let reply = String(result.text ?? "").trim();
    const extracted = this.config.sendMedia
      ? extractAttachments(reply)
      : { text: reply, attachments: [] };
    reply = extracted.text;
    if (!reply && extracted.attachments.length === 0) {
      reply = "DSH 已完成处理，但没有返回文字内容。";
    }
    if (reply && this.config.replyFooter) {
      reply = appendFooter(reply, { workDir: cwd, usage: result.usage });
    }
    return { text: reply, attachments: extracted.attachments };
  }

  /** Upload one local file and send it to the peer as a WeChat image/file. */
  async #sendAttachment(peer, contextToken, filePath) {
    const uploaded = await uploadMediaToCdn({
      filePath,
      toUserId: peer,
      api: this.#clientOrThrow(),
      cdnBaseUrl: this.config.cdnBaseUrl,
      maxBytes: this.config.maxSendBytes,
      timeoutMs: this.config.mediaTimeoutMs,
      log: (message) => this.log?.info(message),
    });
    await this.#clientOrThrow().sendItem({
      toUserId: peer,
      item: buildMediaItem(uploaded),
      contextToken,
    });
    this.log?.info(`sent ${uploaded.kind} to ${peer}: ${uploaded.name} (${uploaded.rawSize} bytes)`);
    return uploaded;
  }

  // ---- outbound ------------------------------------------------------------

  /** Push a message to a peer that has messaged the bot at least once. */
  async sendTo(peer, text) {
    const contextToken = this.state.contextTokenFor(peer);
    if (!contextToken) {
      throw new GatewayError(
        `${peer} 还没有给机器人发过消息，网关要求回复必须带 context_token，所以暂时无法主动推送。`
      );
    }
    return this.#clientOrThrow().sendTextChunks({
      toUserId: peer,
      text,
      contextToken,
      maxChars: this.config.maxReplyChars,
    });
  }

  /** Known peers and the DSH session each one is bound to. */
  peers() {
    return Object.entries(this.state.data.threadIds).map(([peer, sessionId]) => ({
      peer,
      sessionId,
      lastContextToken: Boolean(this.state.contextTokenFor(peer)),
    }));
  }
}

export { extractAttachments, SEND_HINT, ATTACHMENT_MARKER };
