/**
 * 微信连接 (WeChat Connect) — a DeepSeek Harness plugin.
 *
 * Bridges the WeChat ilink bot gateway to DSH: a message from WeChat runs a DSH
 * turn and the answer is sent back to the chat. Login uses the same QR flow the
 * Codex++ 微信连接 extension uses.
 *
 * Two ways to mount it:
 *   • in a bridge profile (e.g. `wechat`) — `enabled: true` starts the long poll
 *     on boot, and the process stays alive serving messages;
 *   • in a profile you already run (desktop/web) — the tools below let you log
 *     in, watch status and push messages; set `enabled: false` to keep the poll
 *     off until you ask for it.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

import { loadConfig } from "./config.js";
import { createLogger, defaultLogFile } from "./log.js";
import { WechatConnectService } from "./service.js";

export const name = "dsh-wechat-connect";
export const inject = ["tools"];

const text = (value) => [{ type: "text", text: String(value) }];
const asString = {
  output: { schema: { type: "string" }, render: (_args, value) => text(value) },
};

/** Render a status snapshot as a compact human-readable report. */
function formatStatus(status) {
  const lines = [
    "微信连接 · WeChat Connect",
    `  状态:      ${status.state}${status.running ? " (运行中)" : ""}`,
    `  说明:      ${status.message}`,
    `  网关:      ${status.baseUrl}`,
    `  账号:      ${status.accountId || "(未登录)"}`,
    `  凭据来源:  ${status.credentialSource}`,
    `  工作目录:  ${status.workDir}`,
    `  会话 profile: ${status.sessionProfile}`,
    `  白名单:    ${status.allowFrom}`,
    `  已处理:    ${status.processedMessages} 条`,
    `  最近消息:  ${status.lastPeerId || "(无)"} @ ${
      status.lastMessageAtMs ? new Date(status.lastMessageAtMs).toISOString() : "从未"
    }`,
    `  联系人:    ${status.peers.length ? status.peers.join(", ") : "(无)"}`,
  ];
  if (status.schedule?.enabled) {
    lines.push(
      `  定时早报:  ${status.schedule.time} 每天` +
        `${status.schedule.runOnStart ? " (启动时先跑一次)" : ""}` +
        ` → ${status.schedule.peers.length ? status.schedule.peers.join(", ") : "全部已知联系人"}`
    );
  } else {
    lines.push("  定时早报:  未启用");
  }
  if (status.host?.ok) {
    lines.push(`  DSH 宿主:  可用`);
  } else {
    lines.push(`  DSH 宿主:  不可用 — ${status.host?.error ?? "未知原因"}`);
  }
  if (status.lastError) lines.push(`  最近错误:  ${status.lastError}`);
  lines.push(`  状态文件:  ${status.stateFile}`);
  lines.push(`  日志:      ${status.logFile}`);
  return lines.join("\n");
}

export function apply(ctx, rawConfig = {}) {
  const home = process.env.DSH_HOME || "";
  const config = loadConfig(rawConfig, { home: home || undefined });
  const logger = createLogger({
    file: config.logFile || defaultLogFile(),
    level: config.logLevel,
    // A GUI host swallows stdout, so only mirror to the console in debug mode.
    echo: config.logLevel === "debug",
  });
  const service = new WechatConnectService(config, logger);

  logger.info(`plugin loaded (enabled=${config.enabled}, profile=${config.sessionProfile})`);

  if (config.enabled) {
    service.start();
    if (!resolveHasToken(service)) {
      logger.warn("no WeChat token yet — run the wechat_connect_login tool to scan a QR code");
    }
  }

  ctx.tools.register(
    defineTool({
      name: "wechat_connect_status",
      description:
        "Report the state of the 微信连接 (WeChat Connect) bridge: whether it is running, " +
        "which WeChat account is logged in, the work directory, the peer allow list, and " +
        "which DSH session each WeChat contact is bound to.",
      parameters: {},
      ...asString,
      async execute() {
        return formatStatus(service.status());
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "wechat_connect_login",
      description:
        "Start the WeChat login flow for 微信连接. Returns a scannable QR code (rendered as " +
        "ASCII art) plus the underlying login URL; scan it with WeChat to authorise the bot. " +
        "The scanned credentials are saved automatically and the bridge restarts.",
      parameters: {
        wait_seconds: {
          type: "string",
          description: "How long to wait for the scan before returning, in seconds (default 120).",
        },
      },
      ...asString,
      async execute(args) {
        const waitSeconds = Math.min(Math.max(Number.parseInt(args.wait_seconds ?? "120", 10) || 120, 5), 300);
        const { qrcode, url, ascii } = await service.loginQr();

        // Poll in the background so the tool can either return the QR immediately
        // or wait for the scan, depending on the caller's patience.
        const deadline = Date.now() + waitSeconds * 1000;
        let scanned = null;
        let failure = null;
        const poll = service
          .awaitLogin(qrcode, {
            onProgress: (status) => logger.info(`scan status: ${status}`),
          })
          .then((credentials) => {
            scanned = credentials;
          })
          .catch((error) => {
            failure = error;
          });

        const header = [
          "用微信扫描下面的二维码完成登录：",
          `  QR id:  ${qrcode}`,
          `  链接:   ${url}`,
          "",
        ].join("\n");

        // Give the scan a chance to land within the caller's window.
        while (!scanned && !failure && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (scanned || failure) break;
        }

        if (scanned) {
          service.start();
          return `${header}✅ 扫码成功，已登录账号 ${scanned.accountId}，微信连接已启动。\n\n${formatStatus(service.status())}`;
        }
        if (failure) {
          return `${header}⚠️ 登录未完成：${failure.message}\n\n${ascii}`;
        }
        return (
          `${header}${ascii}\n\n` +
          `⏳ 还没有等到扫码确认（已等待 ${waitSeconds} 秒）。二维码仍在后台轮询，` +
          `扫码后会自动保存并启动；用 wechat_connect_status 查看结果。`
        );
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "wechat_connect_peers",
      description:
        "List the WeChat contacts that have talked to this bot, with the DSH session each one " +
        "is bound to and whether a reply token is available for them.",
      parameters: {},
      ...asString,
      async execute() {
        const peers = service.peers();
        if (!peers.length) return "还没有任何微信联系人给机器人发过消息。";
        return [
          `共 ${peers.length} 个联系人：`,
          ...peers.map(
            (p, i) => `${i + 1}. ${p.peer}\n   会话: ${p.sessionId}\n   可主动推送: ${p.lastContextToken ? "是" : "否"}`
          ),
        ].join("\n");
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "wechat_connect_send",
      description:
        "Send a WeChat message from the bot to a contact that has messaged it before. The " +
        "gateway requires the context token from an inbound message, so a contact cannot be " +
        "pushed to until they have written first.",
      parameters: {
        peer: { type: "string", required: true, description: "WeChat user id (from wechat_connect_peers)." },
        text: { type: "string", required: true, description: "Message body to send." },
      },
      ...asString,
      async execute(args) {
        const chunks = await service.sendTo(String(args.peer).trim(), String(args.text));
        return `已向 ${args.peer} 发送 ${chunks} 条消息。`;
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "wechat_connect_digest",
      description:
        "Run the configured scheduled digest (定时早报) right now instead of waiting for its " +
        "time: one DSH turn with the schedule prompt per contact, then push the answer text " +
        "and any [[send:...]] document to WeChat. Use it to test the daily briefing.",
      parameters: {},
      ...asString,
      async execute() {
        const result = await service.runDigestNow({ reason: "manual" });
        if (!result.sent) return `未发送任何早报（原因：${result.reason}）。`;
        return `已向 ${result.sent} 个联系人发送早报（原因：${result.reason}）。`;
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: "wechat_connect_control",
      description: "Start or stop the 微信连接 long-polling bridge without restarting DSH.",
      parameters: {
        action: { type: "string", required: true, description: '"start" or "stop".' },
      },
      ...asString,
      async execute(args) {
        const action = String(args.action).trim().toLowerCase();
        if (action === "start") {
          const started = service.start();
          return started ? "微信连接已启动。" : "微信连接已经在运行。";
        }
        if (action === "stop") {
          await service.stop();
          return "微信连接已停止。";
        }
        return `未知操作 "${args.action}"，请用 start 或 stop。`;
      },
    })
  );

  ctx.on("dispose", () => {
    logger.info("plugin disposing — stopping the bridge");
    service.stop().catch(() => {});
  });

  return service;
}

function resolveHasToken(service) {
  try {
    return Boolean(service.status().hasToken);
  } catch {
    return false;
  }
}

export { WechatConnectService };
