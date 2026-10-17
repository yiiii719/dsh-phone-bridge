# 微信连接 · WeChat Connect

DeepSeek Harness 插件。用微信扫码登录一个机器人，之后**在微信里直接跟你的 DSH 智能体对话**。

连接方式与 Codex++ 管理工具里的「微信连接」扩展一致（同一个 ilink 机器人网关、
同一套扫码流程），区别是背后回答你的不是 Codex，而是 DSH。

```
你的微信 ──扫码登录──► 微信 ilink 机器人网关 (ilinkai.weixin.qq.com)
                            ▲                    │
                        发送回复             长轮询拉取
                            │                    ▼
                     dsh-wechat-connect ──► dsh --profile headless
                      (本插件)                (一条持久会话，单一工作目录)
```

> ⚠️ **仅限个人自用**：一个主人、一个机器人、一段对话。请把 `allowFrom` 设成你自己的微信 id；
> 不要用于对外服务、群发营销、骚扰或窥探他人。详见仓库根目录的 `docs/USAGE-BOUNDARY.md`。

## 工作原理

1. `wechat_connect_login` 向网关申请登录二维码，你用微信扫码，网关返回机器人凭据
   （token / ilink_bot_id / baseurl），插件自动保存。
2. 插件对网关做长轮询。有人给机器人发消息时，消息带着 `context_token` 送来。
3. 每条消息被交给一次 DSH 回合：插件调用
   `dsh --profile <sessionProfile> headless --json` 拿回答复文本。
4. 答复按 3800 字符切块发回去，并附一行 `DSH · 上下文占用 / 工作目录` 的署名。

**整段对话绑定一条持久化的 DSH 会话**，工作目录也只有一个（`workDir`）：下次再发消息会用
`--session-id` 续上原来的上下文，不会打断你自己正在用的那些会话。

## 安装

插件通过 DSH 的 profile 机制挂载。profile 就是「一组插件包的组合」。

### 方式一：独立 profile（推荐，默认更安全）

`dsh --profile wechat` 专门跑桥接，常驻监听；你的桌面版 DSH 不受影响。

已经为你创建好了 `%USERPROFILE%\.dsh\profiles\wechat\`：

```bash
dsh --profile wechat
```

首次运行时它**会直接在终端里画出登录二维码**并等待扫码——不需要先开别的会话：

```
========================================================================
  微信连接 · 用微信扫描下面的二维码完成登录
  QR id: b62d4075c872a17cce271967dfd4ff31
  链接:  https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=...&bot_type=3
========================================================================

  █▀▀▀▀▀█ ▀ █▀█ █▀ █ ▀ █▀▀███▄ ▄▄▀  █▀▀▀▀▀█
  █ ███ █ ███▀▀██▄▄▀▀▀ █▀▀▀▀▄▄▄ ▄▄▄ █ ███ █
  ...

等待扫码中（Ctrl+C 取消）…
```

扫码成功后凭据自动保存，桥接随即开始工作；下次启动直接进入监听状态。

### 方式二：挂进你日常用的 profile

这样桌面版一开就自动连上微信。把包加进该 profile 的 `dsh.profile.bundles`：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [
  "...",
  "dsh-wechat-connect"        // ← 加这一行
] } }
```

然后 `dsh plugin --profile desktop install`。

> ⚠️ **安全提醒**：方式二意味着**任何能给这个机器人发消息的人，都能在你电脑上驱动
> DSH 执行任务**（包括跑命令、改文件）。启用前请务必设置 `allowFrom`。
> 方式一至少需要你主动启动进程。

## 使用

挂载后，在 DSH 会话里直接用这几个工具：

| 工具 | 作用 |
| --- | --- |
| `wechat_connect_login` | 获取登录二维码（终端里直接画出来），扫码后自动保存并启动 |
| `wechat_connect_status` | 查看运行状态、登录账号、工作目录、白名单、绑定的会话 |
| `wechat_connect_owner` | 查看当前绑定的联系人、DSH 会话、能否主动推送 |
| `wechat_connect_send` | 主动给主人推送一条消息 |
| `wechat_connect_digest` | 立刻跑一次定时早报（不用等到点） |
| `wechat_connect_control` | 不重启 DSH 的情况下 `start` / `stop` 桥接 |

典型流程：

```
你：帮我连接微信
DSH：（调用 wechat_connect_login）→ 打印二维码 → 你用微信扫
DSH：扫码成功，已登录账号 xxx，微信连接已启动
```

之后在微信里给机器人发消息，就会由 DSH 回答。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，按插件 id 覆盖：

```yaml
- id: wechat-connect
  config:
    enabled: true
    sessionProfile: headless
    workDir: D:\projects
    allowFrom: wxid_你的id
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | profile 启动时是否立刻开始长轮询 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | 网关地址 |
| `allowFrom` | 空 | 白名单。**请设成你自己的微信 id**；空或 `*` = 里所有人都能用（仅限自用的项目不该这样配） |
| `sessionProfile` | `headless` | 用哪个 profile 回答微信消息 |
| `workDir` | 当前目录 | **单一**工作目录（不再按联系人人分子目录） |
| `instructions` | 空 | 追加在每条任务前的人设/边界说明（可选） |
| `routeTag` | 空 | 可选路由标签，非空时带 `skroutetag` 请求头 |
| `longPollTimeoutMs` | `35000` | 长轮询窗口，自动夹在 1–60 秒 |
| `maxReplyChars` | `3800` | 单条回复最大字符数，超出切块 |
| `maxInboundAgeMs` | `300000` | 超过这个年龄的消息丢弃（5 分钟） |
| `downloadMedia` | `true` | 收到图片/文件时是否下载并交给 DSH |
| `incomingDir` | `<workDir>/incoming` | 图片/文件落地目录 |
| `maxMediaBytes` | `20971520` | 单个媒体大小上限（20 MB） |
| `mediaTimeoutMs` | `60000` | 单个媒体下载超时 |
| `sendMedia` | `true` | 是否允许把服务器上的文件发回微信 |
| `cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | 微信 CDN 基址 |
| `maxSendBytes` | `20971520` | 单条发出附件大小上限（20 MB） |
| `replyFooter` | `true` | 是否附加署名行 |
| `logLevel` | `info` | `error` / `warn` / `info` / `debug`（debug 会同时打到控制台） |

登录凭据保存在 `~/.dsh/wechat-connect/credentials.json`，状态在 `state.json`，
日志在 `bridge.log`。凭据优先于 YAML 里的 `token`，所以扫码后不用改配置。

## 测试

```bash
node test/bridge-live.test.js "D:\...\DeepSeek Harness.exe"   # 真实 DSH 回合联调
```

会真跑三轮 DSH：首轮建会话、次轮续会话验证上下文、第三轮验证会话失效后能自动新建，
并检查用量统计与署名格式。全部通过才算成功。

## 已知边界

- **单人自用**：一个主人、一个机器人、一条会话。请把 `allowFrom` 设成你自己的微信 id，
  并把 `workDir` 指向一个你愿意让机器人读写的目录——**能给它发消息的人就能在你机器上
  驱动 DSH 执行任务**（跑命令、改文件）。详见仓库根目录 `docs/USAGE-BOUNDARY.md`。
- **只能被动回复**：网关要求回复必须携带该会话的 `context_token`，所以必须**先给对方
  给机器人发一条消息**，之后才能用 `wechat_connect_send` 主动推送。
- **图片与文件会被下载**：网关把媒体下发为微信 CDN 链接 + AES 密钥，插件用
  AES-128-ECB 解开后落到 `incomingDir`，再把绝对路径写进这一轮的任务文本——
  图片提示可用 `read_image` 查看，文件交给模型的文件工具处理。超过 `maxMediaBytes`
  或下载失败时，任务文本里会写明失败原因，而不是静默丢弃。
- **也能把文件发回微信**：模型在回复末尾单独一行写 `[[send:/绝对路径]]`（多个文件各写
  一行），插件会把这行替换成真实附件：先向网关申请上传位（`getuploadurl`），把文件用
  AES-128-ECB 加密后 POST 到微信 CDN，再用 `sendmessage` 发出 `image_item` / `file_item`。
  按扩展名自动区分图片、视频和普通文件；这一行不会展示给用户。上限 `maxSendBytes`。
- 只处理文本、语音转写文本、图片和文件；视频等其他类型会被忽略。
- 一条消息处理完才处理下一条（串行），和 Codex++ 的行为一致。
- 同一个机器人账号不要同时在多个 profile 里开 `enabled: true`，否则会互相抢消息。
- 二维码编码器支持 version 1–10（M 级 213 字节），登录链接约 90 字节，余量充足；
  超出容量会明确报错，不会静默截断。
