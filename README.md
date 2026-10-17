# dsh-phone-bridge

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）变成**随身可用**的两件套：

1. **微信桥接** —— 在服务器上跑一个微信机器人，随时用微信跟你的 DSH 对话：发文字、发图片、发文档都能处理，也能把服务器上的文件发回给你；还带**每日定时早报**（自动联网汇总国际 + AI 要闻，以文字和 Word 文档两种形式推送）。
2. **手机端界面适配** —— 用插件把 DSH 的网页界面重排成手机 App 的样子：底部导航、单行胶囊输入框、全屏会话列表、右侧栏返回键。**不改 DSH 源码**，走官方首页注入口。

两者都是独立的 DSH 插件，可以只用其中一个。

## 效果

| 手机端 | 微信端 |
|---|---|
| 底部四格导航（会话 / 新对话 / 搜索 / 我的） | 文字、图片、语音、文档双向收发 |
| 单行输入框固定在底部，键盘不遮挡 | 每人独立目录 + 独立会话，互不串台 |
| 会话列表全屏抽屉，历史会话可查 | 定时早报（可配时间/内容） |
| 设置页单列排版、右侧栏一键返回 | 长轮询 + 心跳 + 看门狗，长期在线 |

## 目录结构

```
packages/
  dsh-wechat-connect/    微信桥接插件（iLink 机器人网关）
  dsh-mobile-ui/         手机端界面适配插件（HTTP 注入，不改源码）
deploy/
  systemd/               保活与定时任务单元（自启 / 崩溃重启 / 看门狗 / 会话归类 / 早报）
  scripts/               看门狗与会话归类脚本
  nginx/                 反向代理 + mTLS 设备级访问控制示例
docs/
  SETUP.md               从零部署：服务器、DSH、模型 API、微信登录、手机访问
  PITFALLS.md            踩过的坑（含 DSH 内部机制的硬知识）
```

## 快速开始

```bash
# 1. 服务器上装好 DSH（需要 Node 20+）
npm i -g @deepseek-ai/dsh

# 2. 把插件放进 DSH profile 的 node_modules，并加进 bundles
#    详见 docs/SETUP.md
```

配置示例（`$DSH_HOME/profiles/wechat/cordis.patch.yml`）：

```yaml
- id: wechat-connect
  config:
    enabled: true
    sessionProfile: headless
    workDir: /root/dsh-convos/wechat
    allowFrom: "wxid_your_peer@im.wechat"   # 空或 "*" 表示所有人
    perPeerDirs: true
    schedule:
      enabled: true
      time: "06:00"
      peers: ["wxid_your_peer@im.wechat"]
      prompt: |
        [定时任务·每日早报] …（见 docs/SETUP.md 完整模板）
```

详细步骤（含模型 API、扫码登录、手机访问、保活）见 [docs/SETUP.md](docs/SETUP.md)。

## 设计要点

- **不改 DSH 源码**：手机端适配走 `webserver/index-inject` 注入口；微信桥接是标准 DSH 插件。
- **克隆而不是搬动 DOM**：向 React 管的界面里加按钮时，克隆原节点并转发点击，避免破坏 React 的树。
- **每人一个工作目录**：DSH 的会话按工作目录归属，桥接为每个微信联系人建独立子目录，会话和文件天然隔离。
- **三层保活**：systemd 崩溃重启 + 插件内循环自愈 + 外部心跳看门狗（检测"进程活着但没在工作"）。

## 已知边界

- 机器人是**独立的微信账号**，不是你本人：它只能看到**发给它**的消息，读不到你个人微信里的聊天。
- 主动推送（早报）依赖微信网关的 `context_token`，需要对方先给机器人发过消息。
- 微信 iLink 机器人网关的行为可能随官方调整而变，`channel_version` 不同会导致接口返回结构不同（代码已兼容两种）。

## License

MIT
