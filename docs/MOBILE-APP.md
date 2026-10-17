# 把 DSH 装成手机 App（PWA / 添加到主屏幕）

不需要写 APK、不需要上架应用商店：**Chrome 的「添加到主屏幕」加上一份 PWA 清单，就能得到一个
独立图标、全屏运行、没有地址栏的 App**。这里记录怎么把它做扎实。

## 为什么不能只靠 DSH 自带的清单

DSH 前端自带 `manifest.webmanifest`（`display: fullscreen`、`start_url: ./`），但它有两个短板：

| 问题 | 后果 |
|---|---|
| 图标只有 `favicon.svg` | 安卓上图标可能糊或干脆不显示；iOS 完全不认 |
| 没有 `theme-color` | 状态栏颜色和 App 不搭 |

作者的 `dsh-mobile-ui` 插件通过 `webserver/index-inject` 往 `<head>` 注入一份**自己的清单链接**
（注入的行落在 DSH 自带链接**之前**，而浏览器只用文档里**第一个** manifest），从而覆盖成一份
图标齐全的清单。

## 三步做出来

### 1. 生成图标

```bash
node deploy/pwa/render-icons.mjs \
  /opt/node24/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg \
  /srv/dsh-app
```

产出 4 个文件：

| 文件 | 用途 |
|---|---|
| `icon-192.png` / `icon-512.png` | 普通图标（透明底） |
| `icon-maskable-512.png` | 安卓自适应图标（实心底 + logo 缩到安全区 60%） |
| `apple-touch-icon.png` | iOS 主屏图标（180×180，白底） |

### 2. 放清单 + 让 nginx 暴露它们

把 `manifest.webmanifest.example` 拷贝成 `/srv/dsh-app/manifest.webmanifest`，改掉 `name` /
`theme_color`，然后加一段 nginx location：

```nginx
location /dsh-app/ {
    alias /srv/dsh-app/;
    default_type application/octet-stream;
    types {
        image/png png;
        application/manifest+json webmanifest;
    }
    add_header Cache-Control "public, max-age=86400";
}
```

⚠️ **坑**：
- 目录权限必须是 `755`（宝塔的 nginx worker 跑在 `www` 用户下，`700` 会 404）
- 这段 location 要加在 **443 那个 server 块**里（加进 80 块里等于没加）
- 如果站点有「短链登录」之类的自动改写脚本，注意它的正则可能把你刚加的块清掉——加完立刻 `curl` 验证

### 3. 注入清单链接

`dsh-mobile-ui` 插件已经内置（`config.pwa !== false` 时生效）：

```html
<link rel="manifest" href="/dsh-app/manifest.webmanifest">
<meta name="theme-color" content="#0b0b0c">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="DSH">
<link rel="apple-touch-icon" href="/dsh-app/apple-touch-icon.png">
```

## 让 App「永远能打开」

PWA 启动时按 `start_url` 打开页面。如果 `start_url: "/"`，就要依赖 DSH 的登录 cookie——**cookie
30 天过期后，点开 App 会看到 `dsh web authentication required`**。

把 `start_url` 指向你的登录短链即可自动续期（短链本身也受客户端证书保护）：

```jsonc
"start_url": "/l/YOUR_SHORT_LINK",   // 302 → /?token=... → 落回主界面
```

实测：`/l/xxx -> 200 https://your.domain/`，每次启动都自动登录。

> 没有短链的话，用 nginx 把一个固定路径重定向到当前令牌即可（DSH 每次重启令牌会变，
> 部署脚本里顺手更新这一行就行）。

## 手机上的安装步骤

1. **Chrome**（不是微信/QQ 内置浏览器）打开站点，确认已用客户端证书登录
2. 右上角 **⋮ → 添加到主屏幕 / 安装应用**
3. 桌面出现 DSH 图标，点开就是**全屏**运行，没有地址栏

## 验证清单

```bash
# 清单本身
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  --cert /path/client.crt --key /path/client.key https://your.domain/dsh-app/manifest.webmanifest
# 期望: 200 application/manifest+json

# 没有客户端证书应当被挡住
curl -sk -o /dev/null -w '%{http_code}\n' https://your.domain/dsh-app/manifest.webmanifest
# 期望: 403
```

浏览器侧（Chrome DevTools → Application → Manifest）应看到：名字、`display: standalone`、
192/512/maskable 三个图标，且 **无解析错误**。

## 想要真正的 APK？

可以，但没有必要：PWA 已经是独立图标 + 全屏 + 无浏览器 UI。真要做 APK 的话是
**TWA（Trusted Web Activity）**路线——用 Android SDK + Gradle 把它包一层，另外需要对
`start_url` 做 Digital Asset Links 校验，并且 WebView 里要自己处理客户端证书（`onReceivedClientCertRequest`）。
这套需要装 JDK + Android SDK（几个 GB），本项目的部署脚本里没包含。
