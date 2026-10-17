"use strict";
/**
 * Durable bridge state for a single-owner setup: the long-poll cursor, the one
 * DSH session the owner's chat continues, the owner's last context token, and a
 * bounded set of already-answered messages.
 *
 * Earlier versions kept a map per WeChat peer (one contact, one directory, one
 * session). That machinery is gone: this bridge is for talking to your own bot,
 * so there is exactly one conversation. Old state files are migrated by taking
 * the entry that matches the recorded owner (or the first one).
 */
import { readJson, writeJson } from "./config.js";

// Keep the dedup set bounded; the gateway only replays recent history.
const MAX_PROCESSED = 500;

function emptyState() {
  return {
    cursor: "",
    sessionId: "",
    contextToken: "",
    owner: "",
    processed: [],
    stats: { processedMessages: 0, lastMessageAtMs: 0 },
  };
}

/** Pick the single value out of a legacy per-peer map. */
function legacyPick(map, preferredKey) {
  if (!map || typeof map !== "object") return "";
  if (preferredKey && map[preferredKey]) return map[preferredKey];
  const first = Object.values(map).find((value) => typeof value === "string" && value.trim());
  return first ?? "";
}

function legacyOwner(map, preferredKey) {
  if (!map || typeof map !== "object") return "";
  if (preferredKey && map[preferredKey]) return preferredKey;
  return Object.keys(map)[0] ?? "";
}

class ConnectState {
  constructor(file) {
    this.file = file;
    const raw = readJson(file, null);
    const base = emptyState();
    const legacyOwnerId = raw?.stats?.lastPeerId || "";

    this.data = {
      ...base,
      ...(raw ?? {}),
      // Migrate the old per-peer maps down to single values.
      sessionId: raw?.sessionId || legacyPick(raw?.threadIds, legacyOwnerId) || "",
      contextToken: raw?.contextToken || legacyPick(raw?.contextTokens, legacyOwnerId) || "",
      owner: raw?.owner || legacyOwner(raw?.contextTokens, legacyOwnerId) || legacyOwnerId || "",
      processed: Array.isArray(raw?.processed) ? raw.processed : [],
      stats: { ...base.stats, ...(raw?.stats ?? {}) },
    };
    // Drop the legacy maps so a saved file is already in the new shape.
    delete this.data.threadIds;
    delete this.data.contextTokens;
    this.processedSet = new Set(this.data.processed);
  }

  get cursor() {
    return this.data.cursor;
  }

  set cursor(value) {
    this.data.cursor = String(value ?? "");
  }

  get owner() {
    return this.data.owner;
  }

  set owner(value) {
    const text = String(value ?? "").trim();
    if (text) this.data.owner = text;
  }

  get sessionId() {
    return this.data.sessionId;
  }

  set sessionId(value) {
    this.data.sessionId = String(value ?? "");
  }

  clearSession() {
    this.data.sessionId = "";
  }

  get contextToken() {
    return this.data.contextToken;
  }

  set contextToken(value) {
    const text = String(value ?? "").trim();
    if (text) this.data.contextToken = text;
  }

  get stats() {
    return this.data.stats;
  }

  isProcessed(key) {
    return this.processedSet.has(key);
  }

  markProcessed(key) {
    if (this.processedSet.has(key)) return;
    this.processedSet.add(key);
    this.data.processed.push(key);
    if (this.data.processed.length > MAX_PROCESSED) {
      const dropped = this.data.processed.splice(0, this.data.processed.length - MAX_PROCESSED);
      for (const entry of dropped) this.processedSet.delete(entry);
    }
  }

  noteHandled() {
    this.data.stats.processedMessages += 1;
    this.data.stats.lastMessageAtMs = Date.now();
  }

  save() {
    writeJson(this.file, this.data);
  }
}

export { ConnectState, MAX_PROCESSED };
