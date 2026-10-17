# 部署指南（SETUP）

从一台空的云服务器到"微信能对话 + 手机能访问 + 长期在线"，按顺序做一遍。

约定：服务器是 OpenCloudOS / CentOS 系（其他发行版把包管理命令换掉即可），全部操作在 `root` 下。

---

## 0. 需要一个模型 API

DSH 支持多种模型接入。本项目用 **OpenCode Go** 的 OpenAI 兼容接口举例（换成任何兼容接口都一样）：

```bash
# /etc/dsh.env
OPENCODE_GO_API_KEY=sk-xxxxxxxxxxxxxxxx
```

验证凭据可用（注意 `x-opencode-session` 头）：

```bash
curl -s https://opencode.ai/zen/go/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_GO_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-opencode-session: verify-1" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"reply OK"}],"max_tokens":10}'
```

## 1. 装 Node 与 DSH

不要动系统的 Node，单独装一份，避免和系统包冲突：

```bash
# 以 Node 24 为例
mkdir -p /opt/node24 && cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz
tar -xJf node-v24.14.1-linux-x64.tar.xz -C /opt/node24 --strip-components=1

# 装 DSH（用 /opt/node24 的 npm，并显式指定 prefix）
/opt/node24/bin/npm i -g --prefix /opt/node24 @deepseek-ai/dsh

# 方便调用
cat > /usr/local/bin/dsh <<'EOF'
#!/bin/sh
exec /opt/node24/bin/node /opt/node24/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
EOF
chmod +x /usr/local/bin/dsh
dsh --version
```

## 2. 配 DSH profile

DSH 的每个 profile 是一个插件栈。profile 目录：`$DSH_HOME/profiles/<名字>/`。

`~/.dsh/profiles/wechat/cordis.patch.yml`（桥接进程）：

```yaml
- id: wechat-connect
  config:
    enabled: true
    sessionProfile: headless          # 每轮任务用哪个 profile 跑
    workDir: /root/dsh-convos/wechat  # 单一工作目录（不按联系人人分子目录）
    dshHostExe: /opt/node24/bin/node
    dshCliPath: /opt/node24/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
    allowFrom: "wxid_your_peer@im.wechat"   # 只放行你自己；留空或 "*" 等于对所有人开放
    logLevel: info

    # 每天定时早报（可选）；推送对象就是上面 allowFrom 里的主人
    schedule:
      enabled: true
      time: "06:00"
      runOnStart: false               # true 则启动时先跑一次，便于验证
      prompt: |
        [定时任务·每日早报] 现在是早上六点，给我准备《昨日要闻早报》。要求：
        1. 用 web_search 检索【昨天】发生的事，分两块：
           A. 国际大事：政治外交、经济金融、冲突与突发事件、重要协议或会议；
           B. AI 大事：模型/产品发布、公司动态与融资、重要论文或技术突破、监管政策。
           每块 5-8 条，每条写清「谁 + 做了什么 + 关键数字或影响」。
        2. 只写确实检索到的事实，检索不到就说明没有；每条注明来源媒体与日期。
           检索总次数控制在 12 次以内。
        3. 把完整版写成 Word 文档保存到当前工作目录：早报-YYYY-MM-DD.docx
           （用 python-docx：标题、两个小节、每条小标题 + 2-3 句说明 + 来源链接）。
        4. 然后输出精简版正文作为微信消息（1200 字以内），分两节、用 1. 2. 3. 编号，
           不要用 Markdown 语法（微信不渲染）。
        5. 最后单独一行写 [[send:文档的绝对路径]]。

# 模型路由（pi-ai 适配器里的 provider 默认是休眠的，需要显式激活）
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

> 注意：patch 里的 `config` 是**整体替换**而不是合并。像 `session-title-llm` 这种带必填字段的条目，如果你想改它的 provider，必须把 `targetWords` / `maxInputBytes` 等一起写全，否则会报 `missing required value`。

## 3. 挂上插件

```bash
# 插件目录
install -d /opt/dsh-wechat-connect /opt/dsh-mobile-ui
# 把 packages/ 下的两个插件分别拷进去

# 让 profile 能找到它们
mkdir -p ~/.dsh/profiles/wechat/node_modules ~/.dsh/profiles/web/node_modules
ln -sfn /opt/dsh-wechat-connect ~/.dsh/profiles/wechat/node_modules/dsh-wechat-connect
ln -sfn /opt/dsh-mobile-ui      ~/.dsh/profiles/web/node_modules/dsh-mobile-ui

# 加进 profile 的 bundles 列表
python3 - <<'PY'
import json
p = '/root/.dsh/profiles/wechat/package.json'
d = json.load(open(p, encoding='utf-8'))
b = d['dsh']['profile']['bundles']
if 'dsh-wechat-connect' not in b: b.append('dsh-wechat-connect')
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
```

网页界面那份同理，`bundles` 里加 `dsh-mobile-ui`（web profile）。

## 4. 扫码登录微信

```bash
systemctl start dsh-wechat        # 或直接 dsh --profile wechat
# 日志里会打印二维码（ASCII），用微信扫码
# 成功后凭据存到 ~/.dsh/wechat-connect/credentials.json
```

看到 `login saved for account xxx@im.bot` 就成功了。

## 5. 长轮询与保活

```bash
cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
cp deploy/scripts/dsh-healthcheck /usr/local/bin/
cp deploy/scripts/dsh-workspace-sync /usr/local/bin/
chmod +x /usr/local/bin/dsh-healthcheck /usr/local/bin/dsh-workspace-sync
systemctl daemon-reload
systemctl enable --now dsh-web dsh-wechat dsh-healthcheck.timer dsh-workspace-sync.timer
```

三层保活：

| 层 | 机制 |
|---|---|
| 进程 | systemd `Restart=always` + `StartLimitIntervalSec=0` |
| 循环 | 插件内：长轮询退出后按退避重建（3s → 60s） |
| 假死 | 心跳文件 + 看门狗（5 分钟一查，7 分钟没心跳就重启） |

顺带限制日志占用，避免小磁盘被撑爆：

```bash
mkdir -p /etc/systemd/journald.conf.d
cp deploy/systemd/90-dsh-limits.conf /etc/systemd/journald.conf.d/
systemctl restart systemd-journald
```

## 6. 手机访问（可选，但要安全）

目标：**只有你自己的设备**能打开网页界面。

1. 域名解析到服务器（如果要用 Cloudflare，必须设成 **DNS only**，否则客户端证书会被丢在 CF）
2. nginx 反向代理 + **客户端证书（mTLS）**

```bash
# 自建一套小 CA
mkdir -p /srv/dsh-pki && cd /srv/dsh-pki
openssl req -x509 -newkey rsa:4096 -days 3650 -nodes -keyout ca.key -out ca.crt -subj "/CN=dsh-ca"
# 给每台设备签发一张（手机、电脑各一张）
openssl req -newkey rsa:2048 -nodes -keyout phone.key -out phone.csr -subj "/CN=phone"
openssl x509 -req -in phone.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out phone.crt -days 3650
openssl pkcs12 -export -out phone.p12 -inkey phone.key -in phone.crt -certfile ca.crt   # 手机装这个
```

nginx 关键片段（完整示例见 `deploy/nginx/`）：

```nginx
ssl_client_certificate /srv/dsh-pki/ca.crt;
ssl_verify_client optional;
# 没证书的直接挡掉
if ($ssl_client_verify != SUCCESS) { return 403; }
```

3. 启动 web 时声明受信域名：

```bash
dsh web --no-open --port 18080 --trusted-host example.com
```

4. 首次登录用进程令牌（每次重启会变）：

```
https://example.com/?token=<dsh web 启动日志里的 token>
```

登录后 cookie 有效期 30 天，重启服务不用重新登录。

> 手机浏览器注意：部分国产浏览器（小米、QQ、夸克、百度）不支持客户端证书，会 403。用 Chrome。

## 7. 会话归类（可选）

桥接创建的会话不会自动进 GUI 的工作区，会堆在「未分组」。用 `dsh-workspace-sync` 按会话的 `cwd` 自动归类，配 `dsh-workspace-sync.timer` 每 10 分钟跑一次。

---

## 验证清单

```bash
# 桥接在跑、心跳新鲜
systemctl is-active dsh-wechat
cat ~/.dsh/wechat-connect/heartbeat.json

# 看门狗自检
systemctl start dsh-healthcheck.service && journalctl -u dsh-healthcheck -n 5 --no-pager

# 真跑一轮任务（不经过微信）
cd /root/dsh-convos && DSH_HOME=/root/.dsh dsh headless "只回复四个字：链路正常"

# 早报立刻跑一次：在带会话的界面里调工具
#   wechat_connect_digest
```

## 常见问题

| 现象 | 原因 |
|---|---|
| `dsh web authentication required` | 忘了 `--trusted-host` |
| 手机所有设备都 403 或都能进 | 域名走了 CDN 代理，客户端证书没到服务器 |
| 微信里机器人不回 | 没在 `allowFrom` 里；或 `context_token` 缺失 |
| 早报发不出 | 对方从没给机器人发过消息（没有 context_token） |
| 界面显示「暂无会话」 | `workspace.json` 字段被写坏（见 PITFALLS 第 5 条） |
| 会话都在「未分组」 | 没跑 `dsh-workspace-sync`（见 PITFALLS 第 6 条） |
