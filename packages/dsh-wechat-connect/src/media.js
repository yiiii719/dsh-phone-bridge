/**
 * Download and decrypt WeChat media items.
 *
 * The ilink gateway hands the bot a CDN URL plus an `aes_key`: the wire form is
 * AES-128-ECB ciphertext (with PKCS#7 padding) over the original bytes. Verified
 * against the `md5` the gateway reports for file items, so a decrypt that lands
 * on the wrong scheme is detectable rather than silently corrupt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HEX_KEY = /^[0-9a-f]{32}$/i;
const MEDIA_USER_AGENT = "MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat";
const PADDING_SLACK_BYTES = 64;

/** Strip anything that could escape `dir` or upset a filesystem. */
function safeFileName(name, fallback) {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const trimmed = cleaned.length > 80 ? cleaned.slice(-80) : cleaned;
  return trimmed && trimmed !== "" ? trimmed : fallback;
}

/** Extension chosen from the decrypted bytes, because the gateway names no type. */
function sniffExtension(plain) {
  if (plain.length >= 3 && plain[0] === 0xff && plain[1] === 0xd8 && plain[2] === 0xff) return ".jpg";
  if (plain.length >= 8 && plain.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (plain.length >= 12 && plain.subarray(0, 4).toString("latin1") === "RIFF" && plain.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (plain.length >= 4 && plain.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  if (plain.length >= 4 && plain[0] === 0x50 && plain[1] === 0x4b) return ".zip";
  return "";
}

/** True when the name already carries a usable extension. */
function hasExtension(name) {
  return /\.[A-Za-z0-9]{1,8}$/.test(String(name ?? ""));
}

/** Ciphertext size of AES-128-ECB + PKCS#7 for a plaintext of `size` bytes. */
function aesEcbPaddedSize(size) {
  return Math.ceil((Number(size) + 1) / 16) * 16;
}

/** Encrypt bytes the way the WeChat CDN expects them on upload. */
function encryptAesEcb(plain, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** Which upload slot to ask for: 1=image, 2=video, 3=file. */
function uploadMediaType(kind) {
  if (kind === "image") return 1;
  if (kind === "video") return 2;
  return 3;
}

/** Classify a local path the way the gateway's media types expect. */
function classifyPath(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".m4v", ".avi", ".mkv"].includes(ext)) return "video";
  return "file";
}

/**
 * Upload one local file to the WeChat CDN.
 *
 * Three steps, all required: ask the gateway for an upload slot, POST the
 * AES-128-ECB ciphertext to the CDN, then read the download parameter back out
 * of the `x-encrypted-param` response header.
 * @returns `{ encryptQueryParam, aesKeyBase64, aesKeyHex, rawSize, cipherSize, kind, name }`
 */
async function uploadMediaToCdn({ filePath, toUserId, api, cdnBaseUrl, maxBytes, timeoutMs = 60000, log }) {
  const plain = fs.readFileSync(filePath);
  const limit = Number.isFinite(maxBytes) ? maxBytes : 20 * 1024 * 1024;
  if (plain.length > limit) throw new Error(`文件 ${plain.length} 字节超过发送上限 ${limit}`);

  const kind = classifyPath(filePath);
  const rawsize = plain.length;
  const rawfilemd5 = crypto.createHash("md5").update(plain).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");

  const slot = await api.getUploadUrl({
    filekey,
    media_type: uploadMediaType(kind),
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
  });

  const base = String(cdnBaseUrl ?? "").replace(/\/+$/, "");
  const url =
    slot.uploadFullUrl ||
    `${base}/upload?encrypted_query_param=${encodeURIComponent(slot.uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const cipher = encryptAesEcb(plain, aesKey);

  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(cipher),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 200 && response.status < 300) break;
      const detail = response.headers.get("x-error-message") ?? `HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500) throw new Error(`CDN 拒绝上传：${detail}`);
      lastError = new Error(`CDN 上传失败：${detail}`);
      response = undefined;
    } catch (error) {
      if (String(error.message).includes("CDN 拒绝上传")) throw error;
      lastError = error;
      response = undefined;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  if (!response) throw lastError ?? new Error("CDN 上传失败");

  const encryptQueryParam = response.headers.get("x-encrypted-param");
  if (!encryptQueryParam) throw new Error("CDN 上传响应缺少 x-encrypted-param");
  log?.(`uploaded ${kind} ${path.basename(filePath)} (${rawsize} bytes)`);

  return {
    encryptQueryParam,
    // The gateway wants base64 of the hex *string*, which is the same encoding
    // inbound image items carry.
    aesKeyBase64: Buffer.from(aesKeyHex, "utf8").toString("base64"),
    aesKeyHex,
    rawSize: rawsize,
    cipherSize: filesize,
    kind,
    name: path.basename(filePath),
  };
}

/** Build the outbound item for an uploaded file. */
function buildMediaItem(uploaded) {
  const media = {
    encrypt_query_param: uploaded.encryptQueryParam,
    aes_key: uploaded.aesKeyBase64,
    encrypt_type: 1,
  };
  if (uploaded.kind === "image") {
    return { type: 2, image_item: { media, mid_size: uploaded.cipherSize } };
  }
  if (uploaded.kind === "video") {
    return { type: 5, video_item: { media, video_size: uploaded.cipherSize } };
  }
  return {
    type: 4,
    file_item: { media, file_name: uploaded.name, len: String(uploaded.rawSize) },
  };
}

/**
 * Fetch one media item and write the decrypted bytes under `dir`.
 * @param media - descriptor from `itemMedia()`: `{ kind, url, aesKey, name, size }`.
 * @returns `{ path, bytes, name, kind }`.
 */
async function downloadMedia(media, { dir, maxBytes, timeoutMs = 60000, stamp = Date.now(), log } = {}) {
  const limit = Number.isFinite(maxBytes) ? maxBytes : 20 * 1024 * 1024;
  if (Number(media?.size ?? 0) > limit) {
    throw new Error(`媒体大小 ${media.size} 字节超过上限 ${limit}`);
  }
  if (!media?.url) throw new Error("媒体缺少下载地址");
  const keyHex = Buffer.from(String(media.aesKey ?? ""), "base64").toString("utf8").trim();
  if (!HEX_KEY.test(keyHex)) throw new Error("媒体密钥格式异常");

  const response = await fetch(media.url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": MEDIA_USER_AGENT },
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const cipher = Buffer.from(await response.arrayBuffer());
  if (cipher.length > limit + PADDING_SLACK_BYTES) {
    throw new Error(`媒体响应 ${cipher.length} 字节超过上限 ${limit}`);
  }

  const decipher = crypto.createDecipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  if (plain.length > limit) throw new Error(`媒体解出 ${plain.length} 字节超过上限 ${limit}`);

  const fallback = media.kind === "image" ? `wechat-image-${stamp}` : `wechat-file-${stamp}`;
  const base = safeFileName(media.name, fallback);
  const name = hasExtension(base) ? base : `${base}${sniffExtension(plain)}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${name}`);
  fs.writeFileSync(file, plain);
  log?.(`saved ${media.kind} ${file} (${plain.length} bytes${media.name ? `, name=${media.name}` : ""})`);
  return { path: file, bytes: plain.length, name, kind: media.kind };
}

export {
  downloadMedia,
  uploadMediaToCdn,
  buildMediaItem,
  classifyPath,
  safeFileName,
  sniffExtension,
  aesEcbPaddedSize,
  encryptAesEcb,
};
