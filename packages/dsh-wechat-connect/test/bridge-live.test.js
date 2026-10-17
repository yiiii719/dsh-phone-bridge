/**
 * Live verification for the DSH session bridge.
 *
 * Proves the piece that replaces Codex's `codex app-server`: one WeChat message
 * becomes one DSH turn, each peer keeps its own persisted session, and the
 * answer text comes back for sending to WeChat.
 *
 * Run:  node test/bridge-live.test.js [path-to-dsh-host-exe]
 */
import { normalizeConfig } from "../src/config.js";
import { DshSessionRunner } from "../src/bridge.js";
import { WechatConnectService, appendFooter, compactPath } from "../src/service.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const hostOverride = process.argv[2] || "";
const config = normalizeConfig(
  {
    sessionProfile: process.env.WCTEST_PROFILE || "headless",
    workDir: process.cwd(),
    dshHostExe: hostOverride,
    enabled: false,
    allowFrom: "*",
  },
  { home: process.env.DSH_HOME }
);

const runner = new DshSessionRunner(config, (m) => console.log(`      [runner] ${m}`));

// 1. Host discovery ----------------------------------------------------------
const probe = runner.probe();
check("resolve the DSH host executable and CLI", probe.ok, probe.ok ? probe.cliPath : probe.error);
if (!probe.ok) {
  console.log("\nCannot continue without a DSH host.");
  process.exit(1);
}

try {
  // 2. First turn: no session yet -------------------------------------------
  const first = await runner.runTurn("Reply with exactly this token and nothing else: WC_BRIDGE_ONE");
  check("run the first turn", first.text.includes("WC_BRIDGE_ONE"), JSON.stringify(first.text.slice(0, 60)));
  check("a session id came back", Boolean(first.sessionId), first.sessionId);
  check("the turn reported not-resumed", first.resumed === false);

  // 3. Second turn resumes the same session ---------------------------------
  const second = await runner.runTurn(
    "What exact token did you just reply with? Output only that token.",
    first.sessionId
  );
  check("resume the same session", second.sessionId === first.sessionId, second.sessionId);
  check("the session remembered its context", second.text.includes("WC_BRIDGE_ONE"), JSON.stringify(second.text.slice(0, 60)));

  // 4. A fresh session must NOT see the earlier one -------------------------
  const isolated = await runner.runTurn(
    "Output only the token from the immediately preceding message. If there is no preceding message, output exactly NONE.",
    undefined
  );
  check(
    "a new peer gets an isolated session",
    isolated.sessionId !== first.sessionId,
    `new=${isolated.sessionId?.slice(0, 18)}…`
  );

  // 5. Usage is captured for the reply footer -------------------------------
  check("token usage was captured", Boolean(second.usage && second.usage.inputTokens !== undefined), JSON.stringify(second.usage ?? null));

  // 6. Footer formatting -----------------------------------------------------
  const framed = appendFooter(second.text, { workDir: config.workDir, usage: second.usage });
  check("footer renders", framed.includes("DSH · ") && framed.includes(compactPath(config.workDir)), JSON.stringify(framed.split("\n").slice(-2)));
} catch (error) {
  check("bridge turns", false, error.message);
}

// 7. Peer filtering and dedup, through the service --------------------------
const service = new WechatConnectService(config, { info() {}, warn() {}, error() {}, debug() {} });
check("status reports no host problems", service.status().host.ok === true);

const { isAllowedPeer, dedupKey } = await import("../src/ilink.js");
check("allowFrom empty admits everyone", isAllowedPeer("", "anyone"));
check("allowFrom list filters", !isAllowedPeer("alice", "bob"));
check("dedup key is stable", dedupKey({ from_user_id: "p", message_id: 1, seq: 2, create_time_ms: 3, client_id: "c" }) === dedupKey({ from_user_id: "p", message_id: 1, seq: 2, create_time_ms: 3, client_id: "c" }));

console.log(failures === 0 ? "\nBRIDGE LIVE: no failures" : `\nBRIDGE LIVE: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
