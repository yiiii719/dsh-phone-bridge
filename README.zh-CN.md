# dsh-phone-bridge

**把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）变成随身可用的东西** —— 一个能在微信里随时对话的机器人，加上一个把 DSH 网页界面重排成手机 App 的插件。

[English](README.md) · [部署指南](docs/SETUP.md) · [**装成手机 App**](docs/MOBILE-APP.md) · [踩坑记录](docs/PITFALLS.md) · [**使用边界**](docs/USAGE-BOUNDARY.md)

> ⚠️ **仅限个人自用**。这是一个"一个人 + 一个机器人 + 一段对话"的单人工具，**不授权**用于对外提供服务、群发营销、骚扰他人、窥探隐私、绕过平台规则或替他人托管账号——详见 [使用边界](docs/USAGE-BOUNDARY.md)。一切后果由使用者自负。

<p align="center">
  <img src="docs/images/wechat-digest.jpg" width="45%" alt="微信机器人推送每日早报">
  &nbsp;&nbsp;
  <img src="docs/images/mobile-ui.jpg" width="45%" alt="DSH 网页界面手机端适配">
</p>

## 包含两个独立插件

可以只用其中一个。

### 1. `dsh-wechat-connect` —— 微信桥接

在服务器上长轮询微信 iLink 机器人网关。文字、图片、语音、文件双向收发，**单一工作目录 + 单一 DSH 会话**——这个机器人只服务它自己的主人。

- **发图片给机器人** → DSH 用视觉工具读；**发文档** → DSH 直接打开处理
- **要文件** → 模型在回复里写 `[[send:/绝对路径]]`，桥接自动上传回聊天
- **定时早报** —— 每天到点自动联网汇总前一天的国际 + AI 要闻，以**文字消息 + Word 文档**两种形式推送
- **自愈** —— 长轮询循环失败后自动重建；同时写心跳文件，外部看门狗能发现"进程活着但卡死"

### 2. `dsh-mobile-ui` —— 手机端界面适配

DSH 自带的是三栏桌面布局：手机上输入框被键盘遮住、侧栏把正文挤成一条缝、设置页每个字竖排一行。本插件通过官方 `webserver/index-inject` 注入口送一份样式表 + 一小段脚本，**不改 DSH 源码、不打 dist 补丁**：

| 手机上的问题 | 插件做的事 |
|---|---|
| 左侧图标栏占 56px，控件只有 28px 高 | 底部四格导航，触摸目标 44px |
| 键盘遮住输入框 | 布局高度跟随 `visualViewport` |
| 侧栏把正文挤成 132px | 全屏会话抽屉，选完自动收起 |
| 设置页文字竖排 | 全屏单列，导航变成顶部横向条 |
| 右侧栏打开后没有返回入口 | 常驻「← 返回对话」按钮 |
| iOS 聚焦时整页放大 | 输入框强制 16px |
| 没有主屏图标 | PWA 清单 + PNG 图标 → **可装成 App**（独立图标、全屏、无地址栏） |

> 📱 **还能变成真正的手机 App** —— 不用写 APK、不用上架：Chrome 里「添加到主屏幕」即可，
> 独立图标 + 全屏运行；清单的 `start_url` 指向登录短链后，App 每次启动都会自动登录。
> 详见 [docs/MOBILE-APP.md](docs/MOBILE-APP.md)。

## 目录结构

```
packages/
  dsh-wechat-connect/   微信桥接插件（iLink 网关）
  dsh-mobile-ui/        手机端适配插件（HTTP 注入，不改源码）
deploy/
  systemd/              开机自启、崩溃重启、看门狗、会话归类、journald 上限
  scripts/              看门狗与会话归类脚本
  nginx/                反向代理 + mTLS 设备级访问控制示例
  pwa/                  手机 App 清单示例 + 图标渲染脚本
docs/
  SETUP.md              从零部署全流程
  MOBILE-APP.md         把网页界面装成手机 App（PWA）
  PITFALLS.md           18 条踩坑记录（DSH 内部机制 + 微信网关）
  USAGE-BOUNDARY.md     仅限个人自用的使用边界
```

## 快速开始

```bash
# 服务器需要 Node 20+
npm i -g @deepseek-ai/dsh

# 把插件放进 DSH profile 的 node_modules 并加进 bundles —— 见 docs/SETUP.md
```

最小配置（`$DSH_HOME/profiles/wechat/cordis.patch.yml`）：

```yaml
- id: wechat-connect
  config:
    enabled: true
    sessionProfile: headless
    workDir: /root/dsh-convos/wechat
    allowFrom: "wxid_your_peer@im.wechat"   # 只放行你自己
    workDir: /root/dsh-convos/wechat        # 单一工作目录（不分子目录）
    schedule:
      enabled: true
      time: "06:00"
      peers: ["wxid_your_peer@im.wechat"]
      prompt: |
        [定时任务·每日早报] 检索昨天的大事，写成 Word 文档，
        再输出一段精简版微信消息，最后写 [[send:文档绝对路径]]。
```

完整流程（模型 API、扫码登录、反向代理 + 客户端证书、保活体系）见 **[docs/SETUP.md](docs/SETUP.md)**。

## 设计要点

- **不 fork、不打补丁**：手机端适配走官方注入口；微信桥接是标准 DSH 插件。
- **克隆而不是搬动 DOM**：需要往 React 管的界面里加按钮时（底部导航、输入框右侧控件），克隆原节点并转发点击，绝不动 React 的树。
- **单人单会话**：桥接只维护一个工作目录、一条 DSH 会话 —— 这正是微信机器人网关被设计出来的用法。没有多人联系人那套东西可以配错。
- **三层保活**：systemd 崩溃重启 → 插件内循环重建 → 外部心跳看门狗（对付"进程活着但没在工作"）。

## 已知边界

- 机器人是**独立的微信账号**，不是你本人：它只能看到**发给它**的消息，读不到你个人微信里的聊天。
- 它只为**一个主人**服务。请把 `allowFrom` 设成你自己的微信 id，这样别人即使找到这个机器人也会被忽略。
- 主动推送（早报）依赖微信网关的 `context_token`，需要你先给机器人发过一条消息。
- iLink 机器人网关不是公开版本化的 API，`channel_version` 不同会导致上传接口返回结构不同（代码已兼容两种）。

## License 与使用边界

代码用 MIT 许可；使用范围**仅限个人自用**，详见 [使用边界](docs/USAGE-BOUNDARY.md)。
