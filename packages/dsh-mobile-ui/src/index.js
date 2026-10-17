/**
 * Mobile UI 鈥?a DeepSeek Harness plugin that reshapes the web surface into a
 * phone-shaped chat app.
 *
 * Shipped through the webserver's documented `webserver/index-inject` seam
 * (no source edit, no dist patch):
 *
 *  1. A stylesheet that re-lays-out the shell: full-width conversation, a
 *     capsule composer pinned above a bottom tab bar, and the sidebar as a
 *     full-screen drawer 鈥?rather than the desktop three-column arrangement.
 *  2. A small script that clones four rail buttons into that tab bar. It
 *     clones instead of moving nodes on purpose: React owns the originals and
 *     the clones only forward clicks, so reconciliation is never disturbed.
 *
 * All selectors target the shell's stable `data-slot` / `data-*` hooks.
 * All script strings are ASCII (Chinese via \uXXXX escapes): the injected HTML
 * path does not guarantee UTF-8 inside <script>, and mojibake there is a
 * syntax error that kills the whole script.
 */
export const name = "dsh-mobile-ui";

/** Stylesheet injected into <head> on every page load. */
const MOBILE_CSS = String.raw`
/* ===== DSH mobile shell (plugin-injected) ===== */
@media (max-width: 860px), (pointer: coarse) {
  :root {
    --dsh-nav-h: 58px;
    --dsh-safe-b: env(safe-area-inset-bottom, 0px);
    --dsh-safe-t: env(safe-area-inset-top, 0px);
  }

  /* Height follows the visible viewport (updated by script) so the keyboard
     never hides the composer. */
  [data-slot="root"] > div[data-sidebar-collapsed] {
    height: var(--dsh-vvh, 100dvh) !important;
    max-height: var(--dsh-vvh, 100dvh) !important;
  }

  /* The rail column no longer takes layout space; navigation moved to the
     bottom bar. */
  [class*="frame"] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }

  /* ---------- composer: capsule pinned to the bottom ---------- */
  [data-slot="conversation.composer"] {
    display: block !important; /* slots ship as display:contents */
    position: fixed !important;
    left: 0;
    right: 0;
    bottom: calc(var(--dsh-nav-h) + var(--dsh-safe-b)) !important;
    top: auto !important;
    z-index: 55;
    background: Canvas;
    padding: 8px max(env(safe-area-inset-left), 8px) 10px max(env(safe-area-inset-right), 8px) !important;
    border-top: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
  }
  [data-composer-card] {
    border-radius: 24px !important;
    background: color-mix(in srgb, CanvasText 6%, Canvas) !important;
    border: 1px solid color-mix(in srgb, CanvasText 10%, transparent) !important;
    box-shadow: none !important;
    max-width: 100% !important;
  }
  /* 杈撳叆妗嗭細鍗曡 鈥斺€?鏂囧瓧鍖哄崰婊℃暣琛岋紝鎺т欢娴湪鍙充晶锛堣眴鍖呴偅绉嶏級銆?     涓嶅姩鍗＄墖鑷韩鐨?flex 鏂瑰悜锛堝畠鐨勫唴閮ㄥ竷灞€寰堟晱鎰燂級锛屽彧鎶婃帶浠惰鎶藉嚭鏉ョ粷瀵瑰畾浣嶃€?*/
  [data-composer-card] {
    position: relative !important;
    /* 鎾戞弧鍙敤瀹藉害锛氬惁鍒欏ぇ鍐呰竟璺濅細鎶婂畠鍘嬫垚"鍐呭瀹藉害"锛屽彸渚х┖涓€鍧?*/
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    padding: 0 158px 0 12px !important;
    min-height: 44px;
  }
  [data-composer-card] > *:last-child {
    position: absolute !important;
    right: 4px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    width: auto !important;
    padding: 0 !important;
    gap: 2px !important;
  }
  [data-composer-card] > *:last-child > * {
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 2px !important;
    flex: 0 0 auto !important;
    width: auto !important;
    min-width: 0 !important;
  }
  [data-composer-card] > *:last-child > * > * {
    flex: 0 0 auto !important;
  }
  [data-input-scroll] {
    min-height: 0 !important;
    max-height: 36px !important;
    padding: 6px 0 !important;
    overflow: hidden !important;
  }
  /* 鍗犱綅鏂囨鍗曡鏄剧ず锛岃秴鍑虹渷鐣ワ紝鍒妸杈撳叆妗嗘拺楂?*/
  [data-composer-card] [data-placeholder],
  [data-composer-card] [data-composer-placeholder] {
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    font-size: 15px !important;
  }
  /* 鍙充晶鎺т欢鏀剁獎锛氭ā鍨嬭兌鍥婃渶澶?84px锛屾潈闄愯兌鍥婂彧鐣欏浘鏍?*/
  [data-slot="conversation.input.model"] {
    max-width: 84px !important;
    overflow: hidden !important;
  }
  [data-slot="conversation.input.model"] button {
    padding: 0 4px !important;
    gap: 2px !important;
  }
  [data-slot="conversation.input.permission"] button {
    padding: 0 4px !important;
    min-width: 34px !important;
  }
  [data-slot="conversation.composer"] button {
    min-height: 34px !important;
  }
  [data-slot="conversation.input.right"] button {
    min-width: 40px;
    min-height: 40px;
    border-radius: 999px !important;
  }

  /* 娆㈣繋鏍囬鍧楋紙鍝佺墝 + 銆屾帰绱㈡湭鑷充箣澧冦€? 棰勮鐗堝窘鏍囷級鍦ㄥ皬灞忎笂涓嶆樉绀?*/
  [class*="headline"] {
    display: none !important;
  }
  [class*="composerStack"] {
    padding-bottom: 8px !important;
  }
  /* 16px keeps iOS from zooming the page when the field is focused. */
  [data-composer-input] [contenteditable="true"],
  [data-lexical-editor],
  [data-composer-input] textarea,
  [data-composer-input] input {
    font-size: 16px !important;
    line-height: 1.5 !important;
  }

  /* ---------- conversation body ---------- */
  [data-conversation-scroll] {
    padding-top: calc(var(--dsh-safe-t) + 48px) !important;
    padding-bottom: calc(var(--dsh-nav-h) + var(--dsh-safe-b) + 76px) !important;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  /* ---------- slim top bar ---------- */
  [data-slot="conversation.header"] {
    display: block !important;
    position: fixed !important;
    top: 0;
    left: 0;
    right: 0;
    z-index: 50;
    padding-top: var(--dsh-safe-t);
    background: Canvas;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
  }

  /* ---------- sidebar: full-screen drawer ----------
     The rail and the expanded panel share one subtree, and the frame DROPS the
     data-sidebar-collapsed attribute when it expands (so a "[=false]" selector
     never matches and the column collapses to height 0, clipping the list).
     The script therefore marks the open state on <html> as data-dsh-drawer. */
  [class*="sidebarCol"] {
    position: relative !important;
    width: 0 !important;
    height: 0 !important;
    overflow: visible !important;
    z-index: 70 !important;
  }
  /* collapsed: the rail is replaced by the bottom tab bar */
  [data-sidebar-collapsed="true"] [data-slot="sidebar"] {
    display: none !important;
  }
  /* expanded: the column becomes an overlay that leaves the bottom bar usable */
  html[data-dsh-drawer="open"] [class*="sidebarCol"] {
    position: fixed !important;
    left: 0 !important;
    right: 0 !important;
    top: 0 !important;
    bottom: calc(var(--dsh-nav-h) + var(--dsh-safe-b)) !important;
    width: 100vw !important;
    height: auto !important;
    overflow: hidden !important;
    z-index: 58 !important;
  }
  /* the panel root is the box that directly owns the "new session" row */
  html[data-dsh-drawer="open"] [class*="sidebarCol"] div:has(> [class*="newSession"]) {
    display: flex !important;
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    background: Canvas !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch !important;
    padding-top: var(--dsh-safe-t) !important;
    padding-bottom: var(--dsh-safe-b) !important;
  }

  /* ---------- bottom tab bar (built by script) ---------- */
  #dsh-mobile-tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 60;
    display: flex;
    align-items: stretch;
    justify-content: space-around;
    background: Canvas;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    padding: 4px 4px calc(4px + var(--dsh-safe-b));
  }
  #dsh-mobile-tabbar .dsh-tab {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-height: 50px;
    padding: 6px 2px;
    background: none;
    border: 0;
    color: color-mix(in srgb, CanvasText 62%, transparent);
    font-size: 11px;
    line-height: 1;
    border-radius: 12px;
    touch-action: manipulation;
  }
  #dsh-mobile-tabbar .dsh-tab:active {
    background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  #dsh-mobile-tabbar .dsh-tab svg {
    width: 22px;
    height: 22px;
  }

  /* ---------- composer actions (cloned to the right of the single-line box) ---------- */
  #dsh-mobile-composer-actions {
    position: absolute !important;
    right: 4px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    display: flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 2px !important;
    z-index: 2 !important;
  }
  #dsh-mobile-composer-actions .dsh-act {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
    max-width: 64px;
    min-height: 34px;
    padding: 0 4px;
    overflow: hidden;
    background: none;
    border: 0;
    color: inherit;
    font-size: 12px;
    border-radius: 999px;
    touch-action: manipulation;
  }
  /* 绗竴涓槸銆?銆嶏紝绗簩涓槸璁块棶妯″紡锛堝彧鐣欏浘鏍囷級 */
  #dsh-mobile-composer-actions .dsh-act:first-child {
    max-width: 30px;
    padding: 0 2px;
  }
  #dsh-mobile-composer-actions .dsh-act:nth-child(2) {
    max-width: 46px;
    padding: 0 2px;
  }
  #dsh-mobile-composer-actions .dsh-act:last-child {
    max-width: 46px !important;
    min-width: 42px !important;
    min-height: 42px !important;
    justify-content: center;
  }
  #dsh-mobile-composer-actions .dsh-act > span,
  #dsh-mobile-composer-actions .dsh-act > div {
    max-width: 56px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* original controls row is replaced by the clones above */
  [data-composer-card] > [data-dsh-row-hidden="1"] {
    display: none !important;
  }

  /* ---------- settings panel: full screen, one column ----------
     Desktop puts a 188px nav beside the content; on a phone that crushes the
     content into a strip where every label wraps character by character. */
  [class*="overlay"]:has(> [class*="panel"]) {
    padding: 0 !important;
    align-items: stretch !important;
  }
  [class*="panel"]:has(> [class*="nav"]) {
    flex-direction: column !important;
    width: 100% !important;
    max-width: 100% !important;
    height: var(--dsh-vvh, 100dvh) !important;
    max-height: var(--dsh-vvh, 100dvh) !important;
    border-radius: 0 !important;
    padding-top: var(--dsh-safe-t) !important;
  }
  [class*="panel"]:has(> [class*="nav"]) > [class*="nav"] {
    width: 100% !important;
    flex: 0 0 auto !important;
    border-right: 0 !important;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  /* nav items become a horizontal, scrollable tab strip */
  [class*="navList"] {
    flex-direction: row !important;
    width: 100% !important;
    gap: 6px !important;
    overflow-x: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  [class*="navCell"] {
    flex: 0 0 auto !important;
    width: auto !important;
    min-height: 40px !important;
    white-space: nowrap !important;
  }
  /* content pane takes the rest of the screen */
  [class*="panel"]:has(> [class*="nav"]) > *:not([class*="nav"]) {
    width: 100% !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow-y: auto !important;
  }

  /* ---------- right sidebar: keep a way back ----------
     It opens full screen on a phone; this button is the visible exit. */
  #dsh-mobile-rightbar-back {
    position: fixed;
    left: 12px;
    top: calc(var(--dsh-safe-t) + 10px);
    z-index: 90;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, Canvas 92%, CanvasText);
    color: CanvasText;
    font-size: 13px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
    touch-action: manipulation;
  }
  #dsh-mobile-rightbar-back:active {
    background: color-mix(in srgb, CanvasText 10%, Canvas);
  }

  /* Overlays must fit the screen. */
  [data-slot="shell.overlay"] > * {
    max-width: calc(100vw - 20px) !important;
    max-height: calc(var(--dsh-vvh, 100dvh) - 40px) !important;
  }
}
`;

/** Builds the bottom tab bar from the rail's own buttons. */
const TABBAR_SCRIPT = String.raw`
(function () {
  var TABS = [
    { labels: ["\u6253\u5f00\u4fa7\u8fb9\u680f", "\u6536\u8d77\u4fa7\u8fb9\u680f"], text: "\u4f1a\u8bdd" },
    { labels: ["\u65b0\u5efa\u4f1a\u8bdd"], text: "\u65b0\u5bf9\u8bdd" },
    { labels: ["\u641c\u7d22\u4f1a\u8bdd"], text: "\u641c\u7d22" },
    { labels: ["\u8bbe\u7f6e"], text: "\u6211\u7684" }
  ];

  function buildComposerActions() {
    var card = document.querySelector("[data-composer-card]");
    if (!card) return;
    var host = document.getElementById("dsh-mobile-composer-actions");
    // The controls row is the last direct child that owns buttons.
    var row = null;
    for (var i = card.children.length - 1; i >= 0; i--) {
      var candidate = card.children[i];
      if (candidate.id === "dsh-mobile-composer-actions") continue;
      if (candidate.querySelector && candidate.querySelector("button")) { row = candidate; break; }
    }
    if (!row) return;
    row.setAttribute("data-dsh-row-hidden", "1");
    if (!host) {
      host = document.createElement("div");
      host.id = "dsh-mobile-composer-actions";
      card.appendChild(host);
    }
    var sources = row.querySelectorAll("button");
    if (host.childElementCount === sources.length) return;
    host.textContent = "";
    for (var k = 0; k < sources.length; k++) {
      var clone = document.createElement("button");
      clone.type = "button";
      clone.className = "dsh-act";
      var label = sources[k].getAttribute("aria-label");
      if (label) clone.setAttribute("aria-label", label);
      clone.innerHTML = sources[k].innerHTML;
      (function (target) {
        clone.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          target.click();
        });
      })(sources[k]);
      host.appendChild(clone);
    }
  }

  /**
   * Marks the drawer open state on <html>: the frame drops its
   * data-sidebar-collapsed attribute when expanded, and this script's CSS
   * needs a reliable hook. The panel is drawer-sized (>=120x40) while the
   * collapsed rail is 56px wide, so measuring the column's content decides it.
   */
  function syncDrawer() {
    var col = document.querySelector('[class*="sidebarCol"]');
    var open = false;
    if (col) {
      var nodes = col.querySelectorAll("div, nav, button, ul");
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect();
        if (r.width >= 120 && r.height >= 40) { open = true; break; }
      }
    }
    document.documentElement.setAttribute("data-dsh-drawer", open ? "open" : "closed");
  }

  /**
   * The right sidebar (session info / files / terminal) opens as a full-screen
   * overlay on a phone while its "collapse" and "exit fullscreen" controls sit
   * inside the top-right overflow menu — an easy dead end. This flags the open
   * state and parks a visible "back to conversation" button on top.
   */
  function buildRightbarBack() {
    // The panel renders outside the (always 0-width) rightbar column, so the
    // reliable signal is the app's own collapse control: it is visibility
    // hidden while closed and visible once the panel is up.
    var collapse = document.querySelector('button[aria-label="\u6536\u8d77\u53f3\u4fa7\u8fb9\u680f"]');
    var open = false;
    if (collapse) {
      var style = window.getComputedStyle(collapse);
      var rect = collapse.getBoundingClientRect();
      open = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0;
    }
    document.documentElement.setAttribute("data-dsh-rightbar", open ? "open" : "closed");
    var btn = document.getElementById("dsh-mobile-rightbar-back");
    if (!open) {
      if (btn) btn.remove();
      return;
    }
    if (btn) return;
    btn = document.createElement("button");
    btn.id = "dsh-mobile-rightbar-back";
    btn.type = "button";
    btn.textContent = "\u2190 \u8fd4\u56de\u5bf9\u8bdd";
    btn.setAttribute("aria-label", "\u8fd4\u56de\u5bf9\u8bdd");
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var target = document.querySelector('button[aria-label="\u6536\u8d77\u53f3\u4fa7\u8fb9\u680f"]')
        || document.querySelector('button[aria-label="\u9000\u51fa\u5168\u5c4f"]');
      if (target) target.click();
    });
    document.body.appendChild(btn);
  }

  function build() {
    buildTabBar();
    buildComposerActions();
    syncDrawer();
    buildRightbarBack();
  }

  function buildTabBar() {
    var rail = document.querySelector('[data-slot="sidebar"]');
    if (!rail) return;
    var bar = document.getElementById("dsh-mobile-tabbar");
    if (!bar) {
      bar = document.createElement("nav");
      bar.id = "dsh-mobile-tabbar";
      bar.setAttribute("aria-label", "\u4e3b\u5bfc\u822a");
      document.body.appendChild(bar);
    }
    var buttons = rail.querySelectorAll("button");
    var next = document.createDocumentFragment();
    for (var i = 0; i < TABS.length; i++) {
      var spec = TABS[i];
      var src = null;
      for (var j = 0; j < buttons.length; j++) {
        var name = buttons[j].getAttribute("aria-label") || "";
        if (spec.labels.indexOf(name) !== -1) { src = buttons[j]; break; }
      }
      if (!src) continue;
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "dsh-tab";
      tab.setAttribute("aria-label", spec.text);
      var svg = src.querySelector("svg");
      if (svg) tab.appendChild(svg.cloneNode(true));
      var span = document.createElement("span");
      span.textContent = spec.text;
      tab.appendChild(span);
      (function (target) {
        tab.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          target.click();
        });
      })(src);
      next.appendChild(tab);
    }
    bar.textContent = "";
    bar.appendChild(next);
  }

  function start() {
    build();
    // the drawer opens asynchronously after a click, so re-check shortly after
    document.addEventListener("click", function () {
      setTimeout(syncDrawer, 60);
      setTimeout(syncDrawer, 320);
    }, true);
    // Picking a conversation should reveal it: session rows carry a relative
    // timestamp while workspace rows do not, so that is the hook for closing.
    document.addEventListener("click", function (event) {
      var col = document.querySelector('[class*="sidebarCol"]');
      if (!col || !col.contains(event.target)) return;
      if (
        event.target.closest(
          '[class*="logoRow"], [class*="newSession"], [class*="panelRow"], [class*="footArea"], [class*="sectionHead"], [class*="overflowButton"]'
        )
      ) {
        return;
      }
      var node = event.target;
      var isSessionRow = false;
      for (var i = 0; i < 4 && node && node !== col; i++, node = node.parentElement) {
        var text = node.innerText || "";
        if (/\d+\s*(\u5206\u949f|\u5c0f\u65f6|\u5929|\u5468|\u6708|\u79d2)|\u521a\u521a/.test(text)) { isSessionRow = true; break; }
      }
      if (!isSessionRow) return;
      setTimeout(function () {
        // the collapse control is the icon button in the drawer's brand row
        var toggle = document.querySelector('[class*="sidebarCol"] [class*="logoRow"] button[class*="iconButton"]')
          || document.querySelector('[class*="logoRow"] button[class*="iconButton"]');
        if (toggle && document.documentElement.getAttribute("data-dsh-drawer") === "open") toggle.click();
      }, 420);
    }, true);
    var tries = 0;
    var timer = setInterval(function () {
      build();
      if (++tries > 20) clearInterval(timer);
    }, 700);
    var observer = new MutationObserver(function () {
      clearTimeout(window.__dshTabT);
      window.__dshTabT = setTimeout(build, 200);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
`;

/** Keeps --dsh-vvh in sync with the visible viewport (keyboard aware). */
const VIEWPORT_SCRIPT = String.raw`
(function () {
  var root = document.documentElement;
  function sync() {
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    if (h) root.style.setProperty("--dsh-vvh", Math.round(h) + "px");
  }
  sync();
  window.addEventListener("resize", sync, { passive: true });
  window.addEventListener("orientationchange", sync, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", sync, { passive: true });
    window.visualViewport.addEventListener("scroll", sync, { passive: true });
  }
})();
`;

/**
 * PWA hooks: with these the site installs to the home screen as a real app —
 * its own icon, no browser chrome. Rows injected at the head come before DSH's
 * own <link rel="manifest">, and the first manifest in document order wins, so
 * this one (PNG icons + standalone display) is the one the browser reads.
 * The files live outside the DSH install, so upgrades cannot wipe them.
 */
const PWA_HEAD_HTML = [
  '<link rel="manifest" href="/dsh-app/manifest.webmanifest">',
  '<meta name="theme-color" content="#0b0b0c">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="apple-mobile-web-app-title" content="DSH">',
  '<link rel="apple-touch-icon" href="/dsh-app/apple-touch-icon.png">',
].join("");

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "style", text: MOBILE_CSS });
    table.push({ kind: "script", placement: "head", text: VIEWPORT_SCRIPT });
    if (config.pwa !== false) {
      table.push({ kind: "html", placement: "head", html: PWA_HEAD_HTML });
    }
    if (config.tabBar !== false) {
      table.push({ kind: "script", placement: "head", text: TABBAR_SCRIPT });
    }
  });
}
