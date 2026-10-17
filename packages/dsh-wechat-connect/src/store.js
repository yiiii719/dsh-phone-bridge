"use strict";
/**
 * Durable bridge state: the long-poll cursor, per-peer Codex thread ids, the
 * last context token per peer, and a bounded set of already-answered messages.
 */
import { readJson, writeJson } from "./config.js";

// Keep the dedup set bounded; the gateway only replays recent history.
const MAX_PROCESSED = 500;
const MAX_CONTEXT_TOKENS = 200;

function emptyState() {
  return {
    cursor: "",
    threadIds: {},
    contextTokens: {},
    processed: [],
    stats: { processedMessages: 0, lastPeerId: "", lastMessageAtMs: 0 },
  };
}

class ConnectState {
  constructor(file) {
    this.file = file;
    const raw = readJson(file, null);
    const base = emptyState();
    this.data = {
      ...base,
      ...(raw ?? {}),
      threadIds: { ...(raw?.threadIds ?? {}) },
      contextTokens: { ...(raw?.contextTokens ?? {}) },
      processed: Array.isArray(raw?.processed) ? raw.processed : [],
      stats: { ...base.stats, ...(raw?.stats ?? {}) },
    };
    this.processedSet = new Set(this.data.processed);
  }

  get cursor() {
    return this.data.cursor;
  }

  set cursor(value) {
    this.data.cursor = String(value ?? "");
  }

  get stats() {
    return this.data.stats;
  }

  threadIdFor(peer) {
    return this.data.threadIds[peer];
  }

  setThreadId(peer, threadId) {
    this.data.threadIds[peer] = threadId;
  }

  clearThreadId(peer) {
    delete this.data.threadIds[peer];
  }

  contextTokenFor(peer) {
    return this.data.contextTokens[peer];
  }

  setContextToken(peer, token) {
    const value = String(token ?? "").trim();
    if (!value) return;
    this.data.contextTokens[peer] = value;
    const keys = Object.keys(this.data.contextTokens);
    if (keys.length > MAX_CONTEXT_TOKENS) {
      for (const key of keys.slice(0, keys.length - MAX_CONTEXT_TOKENS)) {
        delete this.data.contextTokens[key];
      }
    }
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

  noteHandled(peer) {
    this.data.stats.processedMessages += 1;
    this.data.stats.lastPeerId = peer;
    this.data.stats.lastMessageAtMs = Date.now();
  }

  save() {
    writeJson(this.file, this.data);
  }
}

export { ConnectState, MAX_PROCESSED };
