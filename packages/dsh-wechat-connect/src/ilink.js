"use strict";
/**
 * Client for the WeChat "ilink" bot gateway that the Codex++ WeChat Connect
 * feature talks to.
 *
 * Transport facts recovered from the shipped Codex++ manager binary
 * (sha256 8a512226...) and confirmed against the live gateway:
 *   GET  ilink/bot/get_bot_qrcode?bot_type=3
 *   GET  ilink/bot/get_qrcode_status?qrcode=<id>
 *   POST ilink/bot/getupdates          (long poll)
 *   POST ilink/bot/sendmessage
 * Auth headers: authorizationtype: ilink_bot_token, authorization: Bearer <token>,
 * plus x-wechat-uin and optional skroutetag / ilink-app-clientversion.
 */
import * as crypto from "node:crypto";

const CHANNEL_VERSION = "codex-plus-weixin/1.0";
const MAX_API_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_SMALL_RESPONSE_BYTES = 1024 * 1024;

/** Message item types observed in the wire format. */
const ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
/** `message_type` for an inbound user message. */
const MESSAGE_TYPE_USER = 1;
/** `message_state` once the peer has finished composing. */
const MESSAGE_STATE_FINISHED = 2;

class GatewayError extends Error {
  constructor(message, { ret, errcode, httpStatus, cause } = {}) {
    super(message);
    this.name = "GatewayError";
    this.ret = ret;
    this.errcode = errcode;
    this.httpStatus = httpStatus;
    if (cause) this.cause = cause;
  }
}

/** `x-wechat-uin` is a base64-encoded random decimal integer in the shipped client. */
function randomWechatUin() {
  const bytes = crypto.randomUUID().replace(/-/g, "");
  const value = parseInt(bytes.slice(0, 8), 16) >>> 0;
  return Buffer.from(String(value), "utf8").toString("base64");
}

/** Streaming read with a hard byte cap, so a hostile peer cannot exhaust memory. */
async function readLimited(response, limit, label) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new GatewayError(`${label} exceeded the size limit`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) {
      throw new GatewayError(`${label} exceeded the size limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer, label) {
  const text = buffer.toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GatewayError(`${label} response was not valid JSON`, { cause: error });
  }
}

class WeixinClient {
  constructor({ baseUrl, token = "", routeTag = "" }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.token = String(token || "").trim();
    this.routeTag = String(routeTag || "").trim();
  }

  endpoint(pathname) {
    return `${this.baseUrl}/${String(pathname).replace(/^\/+/, "")}`;
  }

  routeHeaders({ qrStatus = false } = {}) {
    const headers = {};
    if (qrStatus) headers["ilink-app-clientversion"] = "1";
    if (this.routeTag) headers["skroutetag"] = this.routeTag;
    return headers;
  }

  authHeaders() {
    const headers = {
      ...this.routeHeaders(),
      authorizationtype: "ilink_bot_token",
      authorization: `Bearer ${this.token}`,
      "x-wechat-uin": randomWechatUin(),
    };
    return headers;
  }

  // ---- Login -------------------------------------------------------------

  /** Fetch a fresh login QR code. Returns `{ qrcode, qrcodeImgContent }`. */
  static async fetchQrCode({ baseUrl, routeTag = "", signal } = {}) {
    const client = new WeixinClient({ baseUrl, routeTag });
    let response;
    try {
      response = await fetch(client.endpoint("ilink/bot/get_bot_qrcode?bot_type=3"), {
        method: "GET",
        headers: client.routeHeaders(),
        signal: signal ?? AbortSignal.timeout(40000),
      });
    } catch (error) {
      throw new GatewayError("could not fetch the WeChat login QR code", { cause: error });
    }
    const body = await readLimited(response, MAX_SMALL_RESPONSE_BYTES, "WeChat QR code");
    if (!response.ok) {
      throw new GatewayError(`could not fetch the WeChat login QR code: HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    const payload = parseJson(body, "WeChat QR code");
    if (payload.ret !== undefined && payload.ret !== 0) {
      throw new GatewayError(`QR request rejected: ret=${payload.ret} ${payload.errmsg ?? ""}`.trim(), {
        ret: payload.ret,
      });
    }
    const qrcode = String(payload.qrcode ?? "").trim();
    const qrcodeImgContent = String(payload.qrcode_img_content ?? "").trim();
    if (!qrcode || !qrcodeImgContent) {
      throw new GatewayError("WeChat QR response is missing required fields");
    }
    return { qrcode, qrcodeImgContent };
  }

  /**
   * Poll the scan state for a QR code.
   * `status` values observed: `wait`, `scaned`, `confirmed`, `expired`.
   * A timeout is not an error: it simply means "still waiting".
   */
  static async pollQrStatus({ baseUrl, routeTag = "", qrcode, signal } = {}) {
    const client = new WeixinClient({ baseUrl, routeTag });
    let response;
    try {
      response = await fetch(
        client.endpoint(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`),
        { method: "GET", headers: client.routeHeaders({ qrStatus: true }), signal: signal ?? AbortSignal.timeout(40000) }
      );
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        return { status: "wait", botToken: "", ilinkBotId: "", baseurl: "", ilinkUserId: "" };
      }
      throw new GatewayError("could not query the WeChat scan status", { cause: error });
    }
    const body = await readLimited(response, MAX_SMALL_RESPONSE_BYTES, "WeChat scan status");
    if (!response.ok) {
      throw new GatewayError(`could not query the WeChat scan status: HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    const payload = parseJson(body, "WeChat scan status");
    return {
      status: String(payload.status ?? ""),
      botToken: String(payload.bot_token ?? ""),
      ilinkBotId: String(payload.ilink_bot_id ?? ""),
      baseurl: String(payload.baseurl ?? ""),
      ilinkUserId: String(payload.ilink_user_id ?? ""),
    };
  }

  // ---- Message pump ------------------------------------------------------

  /**
   * Long-poll for new messages.
   * @param {string} cursor opaque `get_updates_buf` cursor from the previous call
   * @param {number} timeoutMs server-side long-poll window
   */
  async getUpdates(cursor = "", timeoutMs = 35000) {
    const clamped = Math.min(Math.max(Number(timeoutMs) || 35000, 1000), 60000);
    const body = {
      get_updates_buf: cursor,
      base_info: { channel_version: CHANNEL_VERSION },
    };
    let response;
    try {
      response = await fetch(this.endpoint("ilink/bot/getupdates"), {
        method: "POST",
        headers: { ...this.authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
        // Allow the server window plus a margin before giving up.
        signal: AbortSignal.timeout(clamped + 5000),
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        // A quiet window is normal; report "no news" instead of failing.
        return { ret: 0, errcode: 0, errmsg: "", messages: [], cursor, longPollingTimeoutMs: clamped };
      }
      throw new GatewayError("WeChat long poll failed", { cause: error });
    }
    const buffer = await readLimited(response, MAX_API_RESPONSE_BYTES, "WeChat long poll");
    if (!response.ok) {
      throw new GatewayError(`WeChat long poll failed: HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    const payload = parseJson(buffer, "WeChat long poll");
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    if (ret !== 0 || errcode !== 0) {
      throw new GatewayError(
        `WeChat long poll rejected: ret=${ret} errcode=${errcode} ${payload.errmsg ?? ""}`.trim(),
        { ret, errcode }
      );
    }
    return {
      ret,
      errcode,
      errmsg: String(payload.errmsg ?? ""),
      messages: Array.isArray(payload.msgs) ? payload.msgs : [],
      cursor: String(payload.get_updates_buf ?? "") || cursor,
      longPollingTimeoutMs: Number(payload.longpolling_timeout_ms ?? 0) || clamped,
    };
  }

  /** Send one text message. `contextToken` is required by the gateway. */
  async sendText({ toUserId, text, contextToken }) {
    if (!String(contextToken ?? "").trim()) {
      throw new GatewayError("cannot reply: the inbound message had no context_token");
    }
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const response = await fetch(this.endpoint("ilink/bot/sendmessage"), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const buffer = await readLimited(response, MAX_SMALL_RESPONSE_BYTES, "WeChat send");
    if (!response.ok) {
      throw new GatewayError(`could not send the WeChat reply: HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    // An empty (or whitespace-only) body means success.
    if (buffer.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)) return;
    const payload = parseJson(buffer, "WeChat send");
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    if (ret !== 0 || errcode !== 0) {
      throw new GatewayError(
        `WeChat reply rejected: ret=${ret} errcode=${errcode} ${payload.errmsg ?? ""}`.trim(),
        { ret, errcode }
      );
    }
  }

  /**
   * Ask the gateway for a CDN upload slot for one outbound media file.
   *
   * The gateway has two response shapes depending on the advertised
   * `channel_version`: an opaque `upload_param` the client must turn into a CDN
   * URL, or a ready-made `upload_full_url`. Accept both.
   * @returns `{ uploadParam, uploadFullUrl }` (one of them non-empty).
   */
  async getUploadUrl(request) {
    const body = { ...request, base_info: { channel_version: CHANNEL_VERSION } };
    const response = await fetch(this.endpoint("ilink/bot/getuploadurl"), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const buffer = await readLimited(response, MAX_SMALL_RESPONSE_BYTES, "WeChat upload url");
    if (!response.ok) {
      throw new GatewayError(`could not get a WeChat upload url: HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    const payload = parseJson(buffer, "WeChat upload url");
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    if (ret !== 0 || errcode !== 0) {
      throw new GatewayError(
        `WeChat rejected the upload url request: ret=${ret} errcode=${errcode} ${payload.errmsg ?? ""}`.trim(),
        { ret, errcode }
      );
    }
    const uploadParam = String(payload.upload_param ?? "").trim();
    const uploadFullUrl = String(payload.upload_full_url ?? "").trim();
    if (!uploadParam && !uploadFullUrl) {
      throw new GatewayError("WeChat returned neither upload_param nor upload_full_url");
    }
    return { uploadParam, uploadFullUrl };
  }

  /**
   * Send one already-uploaded item (image/file/video) as its own message.
   * The gateway wants media items sent one per request, each echoing the
   * conversation's `context_token`.
   */
  async sendItem({ toUserId, item, contextToken }) {
    if (!String(contextToken ?? "").trim()) {
      throw new GatewayError("cannot send media: the inbound message had no context_token");
    }
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };
    const response = await fetch(this.endpoint("ilink/bot/sendmessage"), {
      method: "POST",
      headers: { ...this.authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const buffer = await readLimited(response, MAX_SMALL_RESPONSE_BYTES, "WeChat media send");
    if (!response.ok) {
      throw new GatewayError(`could not send the WeChat media message: HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    if (buffer.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)) return;
    const payload = parseJson(buffer, "WeChat media send");
    const ret = Number(payload.ret ?? 0);
    const errcode = Number(payload.errcode ?? 0);
    if (ret !== 0 || errcode !== 0) {
      throw new GatewayError(
        `WeChat media message rejected: ret=${ret} errcode=${errcode} ${payload.errmsg ?? ""}`.trim(),
        { ret, errcode }
      );
    }
  }

  /** Split a long answer across several messages, preserving character boundaries. */
  async sendTextChunks({ toUserId, text, contextToken, maxChars = 3800, gapMs = 100 }) {
    const characters = Array.from(text);
    if (characters.length === 0) return 0;
    let sent = 0;
    for (let i = 0; i < characters.length; i += maxChars) {
      const chunk = characters.slice(i, i + maxChars).join("");
      await this.sendText({ toUserId, text: chunk, contextToken });
      sent++;
      if (i + maxChars < characters.length) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    }
    return sent;
  }
}

// ---- Message helpers --------------------------------------------------------

/** Extract the readable body of one item, flattening quoted replies. */
function itemText(item) {
  if (!item || typeof item !== "object") return null;
  const type = Number(item.type ?? 0);
  let body;
  if (type === ITEM_TYPE.TEXT) body = item.text_item?.text;
  else if (type === ITEM_TYPE.VOICE) body = item.voice_item?.text;
  else return null;
  const text = String(body ?? "").trim();
  if (!text) return null;
  const reference = item.ref_msg;
  if (!reference || typeof reference !== "object") return text;
  const parts = [];
  const title = String(reference.title ?? "").trim();
  if (title) parts.push(title);
  const quoted = itemText(reference.message_item);
  if (quoted) parts.push(quoted);
  return parts.length ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
}

/** First readable text item of a message, or null. */
function messageText(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  for (const item of items) {
    const text = itemText(item);
    if (text) return text;
  }
  return null;
}

/**
 * Media descriptor for one image/file item, or null.
 *
 * The gateway delivers the bytes as a WeChat CDN URL plus an AES key; nothing is
 * downloadable without both, so an item missing either half is treated as
 * unsupported rather than half-forwarded.
 * @returns `{ kind, url, aesKey, name, size, md5 }` or null.
 */
function itemMedia(item) {
  if (!item || typeof item !== "object") return null;
  const type = Number(item.type ?? 0);
  if (type === ITEM_TYPE.IMAGE) {
    const image = item.image_item;
    const media = image?.media;
    if (!media?.full_url || !media?.aes_key) return null;
    return {
      kind: "image",
      url: String(media.full_url),
      aesKey: String(media.aes_key),
      name: "",
      size: Number(image.mid_size ?? 0) || 0,
      md5: "",
    };
  }
  if (type === ITEM_TYPE.FILE) {
    const file = item.file_item;
    const media = file?.media;
    if (!media?.full_url || !media?.aes_key) return null;
    return {
      kind: "file",
      url: String(media.full_url),
      aesKey: String(media.aes_key),
      name: String(file.file_name ?? ""),
      size: Number(file.len ?? 0) || 0,
      md5: String(file.md5 ?? ""),
    };
  }
  return null;
}

/** Every image/file item of a message, in order. */
function messageMedia(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const found = [];
  for (const item of items) {
    const media = itemMedia(item);
    if (media) found.push(media);
  }
  return found;
}

/** Only finished inbound user messages are actionable. */
function isActionableMessage(message) {
  return (
    Number(message?.message_type ?? 0) === MESSAGE_TYPE_USER &&
    Number(message?.message_state ?? 0) === MESSAGE_STATE_FINISHED &&
    String(message?.from_user_id ?? "").trim() !== ""
  );
}

/** Stable identity used to avoid answering the same message twice. */
function dedupKey(message) {
  return [
    String(message?.from_user_id ?? "").trim(),
    Number(message?.message_id ?? 0),
    Number(message?.seq ?? 0),
    Number(message?.create_time_ms ?? 0),
    String(message?.client_id ?? "").trim(),
  ].join("|");
}

/** `allowFrom` semantics: empty or "*" means everyone, else an exact-match list. */
function isAllowedPeer(allowFrom, peer) {
  const list = String(allowFrom ?? "").trim();
  if (list === "" || list === "*") return true;
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(String(peer ?? "").trim());
}

export {
  CHANNEL_VERSION,
  ITEM_TYPE,
  MESSAGE_TYPE_USER,
  MESSAGE_STATE_FINISHED,
  GatewayError,
  WeixinClient,
  randomWechatUin,
  messageText,
  itemText,
  itemMedia,
  messageMedia,
  isActionableMessage,
  dedupKey,
  isAllowedPeer,
};
