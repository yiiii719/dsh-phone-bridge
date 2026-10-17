# 踩过的坑（PITFALLS）

这份文档记录开发过程中真实踩到、并且花时间才定位出来的问题。每一条都是"反直觉 + 会让人卡很久"的类型。

## DSH 本体内部机制

### 1. `data-slot` 容器是 `display: contents`，不能直接定位

DSH 的界面用 `data-slot="..."` 标注插槽，但这些包装元素的 `display` 是 `contents`——**对它们设置 `position: fixed/absolute` 没有任何效果**。

```css
/* ❌ 无效：元素根本不是个盒子 */
[data-slot="conversation.composer"] { position: fixed; bottom: 0; }

/* ✅ 先把它变成盒子 */
[data-slot="conversation.composer"] {
  display: block !important;
  position: fixed !important;
  bottom: 0;
}
```

### 2. 展开侧栏时 `data-sidebar-collapsed` 属性会**消失**（不是变成 `false`）

```css
/* ❌ 永远不会命中：展开时属性被整个移除 */
[data-sidebar-collapsed="false"] [class*="sidebarCol"] { ... }
```

正确做法：用脚本测量侧栏内容尺寸，把状态写到 `<html>` 上：

```js
const col = document.querySelector('[class*="sidebarCol"]');
let open = false;
for (const el of col.querySelectorAll("div, nav, button")) {
  const r = el.getBoundingClientRect();
  if (r.width >= 120 && r.height >= 40) { open = true; break; }  // 图标栏只有 56px 宽
}
document.documentElement.setAttribute("data-dsh-drawer", open ? "open" : "closed");
```

同类坑：右侧边栏的面板**不在** `rightbarCol` 里（那一列永远是 0 宽），可靠信号是它自己的「收起右侧边栏」按钮——关闭时 `visibility: hidden`，打开时才可见。

### 3. 把某一列改成 `position: fixed` 会让栅格串列

框架是 `grid-template-columns: 56px minmax(0,1fr) minmax(0,0)` 的三列栅格。如果你把第一列（`sidebarCol`）改成 `fixed`，它会脱离栅格流，后面的列全部**前移一格**→ 正文掉进 0 宽的列里，界面直接空白。

正确做法：让列留在流里（`position: relative; width: 0`），把浮层做在**它的子元素**上。

### 4. 注入的 `<script>` 里写中文会变成语法错误

通过 `webserver/index-inject` 注入的脚本，**非 ASCII 字符可能被转码**，中文变成乱码 → JS 直接抛 `Unexpected identifier` → 整个脚本不执行。

```js
// ❌ 注入后可能变成 "Unexpected identifier '鏀惰捣渚ц竟鏍'"
const text = "会话";

// ✅ 全部用 Unicode 转义
const text = "\u4f1a\u8bdd";
```

（CSS 里的中文注释也会变乱码，但注释无所谓，不影响生效。）

### 5. 工作区登记表的 `updatedAt` 必须是 ISO 字符串

`$DSH_HOME/storages/workspace.json` 的 `updatedAt` 写成数字（epoch 毫秒）会导致：

```
DomainError: domain 'workspace': stored record '...' does not match its schema
ZodError: Invalid input: expected string, received number
```

后果不是"这个字段被忽略"，而是**整个工作区服务不激活**，界面显示「暂无会话」。

### 6. GUI 的会话归属靠登记表，不扫目录

在 GUI 里创建的会话会自动登记进工作区；**桥接 / 命令行创建的会话不会**——它们记在磁盘上（`$DSH_HOME/sessions/<转义的工作目录>/<会话id>/`），但没人往工作区里登记，于是永远显示在「未分组」。

解决办法：读每个会话日志第一行的 `cwd`，把 `sessionId` 补进对应工作区（`deploy/scripts/dsh-workspace-sync`）。注意宿主要重启或等它重新加载才会生效。

## 微信 iLink 机器人网关

### 7. 主动发消息必须有 `context_token`

网关要求回复携带上一条消息的 `context_token`，所以**机器人不能给从没跟它说过话的人发消息**。定时推送之前，对方必须先发过一条（`allowFrom` 也要放行）。

### 8. `x-opencode-session` 头是必须的

若直接把 iLink 当 OpenAI 兼容接口调，会得到：

```
HTTP 400 {"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}
```

带上这个头（值可以是任意会话标识）就正常了。

### 9. `getuploadurl` 的返回结构取决于 `channel_version`

- `channel_version = codex-plus-weixin/1.0` → 返回 `upload_full_url`
- `channel_version = 2.0.0` → 返回 `upload_param`

只认其中一种就会在换版本后突然传不了文件。代码里两种都要兼容。

### 10. 媒体是两个方向都要 AES-128-ECB

上传前要按 PKCS#7 补齐到 16 字节整数倍，下载要解密；CDN 与网关是两套域名（`novac2c.cdn.weixin.qq.com` / `ilinkai.weixin.qq.com`）。

## 反向代理与手机访问

### 11. 走 Cloudflare 会丢掉客户端证书

mTLS 的设备级访问控制依赖 TLS 层的客户端证书。如果域名解析挂在 Cloudflare 的橙色云朵（代理模式）后面，TLS 在 CF 就终止了，**证书根本到不了你的服务器**——所有设备都会 403，或者所有设备都放行。

要么把记录改成 DNS only（灰云），要么用 CF 的 mTLS 功能自己实现。

### 12. 有些手机浏览器不带客户端证书

小米浏览器 / QQ 浏览器 / 夸克 / 百度浏览器在 Android 上不发起客户端证书请求（服务端看到的 `ssl_client_verify` 是 `NONE`）→ 一律 403。Chrome 正常。

### 13. 代理后面的首次登录需要 `--trusted-host`

DSH 的 web 服务默认只信任 `127.0.0.1`。挂在反向代理后面必须显式声明：

```bash
dsh web --port 18080 --trusted-host example.com
```

否则浏览器拿到 `dsh web authentication required`。

### 14. 重启 dsh-web 会换令牌

进程令牌每次启动都变，短链（`/?token=...`）要跟着更新。已经登录的浏览器 cookie 不受影响。

## 保活

### 15. "进程活着"不等于"服务在工作"

长轮询循环可能悄悄退出（异常、目录被删、宿主不可用），而进程还挂着，systemd 的 `Restart=always` 什么都不会做。

对策两层：

1. **插件内自愈**：循环退出后按退避重建（3s 起，最长 60s），除非是显式 stop。
2. **外部看门狗**：桥接每轮询一次就写 `heartbeat.json`；定时任务发现心跳超过 7 分钟没更新 → 重启服务。

### 16. journald 会把小服务器的磁盘吃满

默认上限可能就是磁盘的一大块（实测占用 1.0G）。加 `/etc/systemd/journald.conf.d/*.conf` 限制 `SystemMaxUse=300M`，并给应用日志配 logrotate。

## 其他

### 17. 用 PowerShell 编辑 UTF-8 源码会把中文弄坏

`Get-Content -Raw` + `Set-Content -Encoding UTF8` 往返一次，中文注释就变乱码，JS 里的中文字符串甚至会**断掉引号**导致语法错误。改 UTF-8 源码要么用编辑器，要么用能明确指定编码的工具，改完务必 `node --check` 验证。

### 18. 通过 SSH 传 here-string 会带上 CRLF

Windows 上的 here-string 送给 `bash -s`，脚本里会出现 `\r`，报 `$'\r': command not found`，还会让 `tail -1` / `head -1` 这类命令行为异常。传脚本文件比传 here-string 可靠：先 `scp`，再 `sed -i 's/\r$//'`，然后执行。
