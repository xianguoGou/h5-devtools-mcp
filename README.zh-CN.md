# h5-devtools-mcp

[![npm version](https://img.shields.io/npm/v/h5-devtools-mcp.svg)](https://www.npmjs.com/package/h5-devtools-mcp)
[![npm downloads](https://img.shields.io/npm/dm/h5-devtools-mcp.svg)](https://www.npmjs.com/package/h5-devtools-mcp)
[![license](https://img.shields.io/npm/l/h5-devtools-mcp.svg)](LICENSE)

[English](README.md) | 简体中文

一个 MCP 服务，让 Claude Code、Codex、Cursor 等编程 Agent 直接调试 **Android WebView 和 iOS WKWebView 里的 H5 页面**：读取 console 日志和未捕获异常，在页面里执行 JavaScript，不用再手动打开 `chrome://inspect` 或 Safari Web 检查器。

> 状态：v0.2，早期版本。支持 Android 真机和 iOS 模拟器（iPhone 真机走同一个代理，理论上可用，但还没验证过）。

## 工作原理

```
编程 Agent ──MCP (stdio)──▶ h5-devtools-mcp ──adb forward──▶ webview_devtools_remote_<pid> ──CDP──▶ WebView 页面
```

每个开启了调试的 WebView 都会在一个 abstract unix socket 上暴露 Chrome DevTools Protocol（CDP）接口。本服务通过 adb 找到这些 socket（和 `chrome://inspect` 的做法一样），转发到本地端口，再用 CDP 连接。

```
编程 Agent ──MCP (stdio)──▶ h5-devtools-mcp ──▶ ios_webkit_debug_proxy ──WebKit Inspector Protocol──▶ WKWebView 页面
```

iOS 这边，本服务会自己启动 [ios_webkit_debug_proxy](https://github.com/google/ios-webkit-debug-proxy)（模拟器一个、USB 真机一个），退出时一起关掉。两个平台的页面出现在同一个 `list_targets` 里，其他工具的用法完全一样。

## 环境要求

- Node.js 18+

**Android**

- `adb` 在 `PATH` 里（或者设置 `ADB_PATH` 环境变量）
- Android 设备已开启 USB 调试
- App 需要打开 WebView 调试（debug 包一般默认开启）：

```java
WebView.setWebContentsDebuggingEnabled(true);
```

只在 debug 包里打开：正式包开启后，任何能通过 adb 连上手机的人都能读取 WebView 里的 cookie 和 storage。

**iOS**（仅限 macOS）

- `brew install ios-webkit-debug-proxy`（或者设置 `IWDP_PATH` 环境变量）
- 已启动的 iOS 模拟器；或者 USB 连接的 iPhone，并在「设置 › Safari › 高级」里打开「网页检查器」
- App 的 WKWebView 要设成可调试（iOS 16.4+），同样只在 debug 包里打开：

```swift
if #available(iOS 16.4, *) { webView.isInspectable = true }
```

Safari 里的页面不需要 App 做任何改动。

## 安装

```bash
# Claude Code
claude mcp add h5-devtools -- npx -y h5-devtools-mcp
```

其他 MCP 客户端（Cursor、Codex 等）用同一条命令：`npx -y h5-devtools-mcp`。

### 从源码安装

```bash
git clone https://github.com/xianguoGou/h5-devtools-mcp.git
cd h5-devtools-mcp
npm install && npm run build
claude mcp add h5-devtools -- node /absolute/path/to/h5-devtools-mcp/dist/index.js
```

## 工具

| 工具 | 作用 |
|---|---|
| `list_targets` | 列出 Android 和 iOS 上可调试的页面：App、标题、URL、是否可见 |
| `attach` | 连接一个页面，开始缓存 console 输出 |
| `get_console` | 读取缓存的日志，可按级别、关键字、`exclude_keywords` 过滤，用 `since_seq` 增量读取 |
| `evaluate_js` | 在页面里执行一段 JavaScript 并返回结果（会等待 Promise 完成） |
| `detach` | 断开与页面的连接 |

输出尽量节省 token：每条日志压缩成一行，过长的消息会截断；用 `since_seq` 只读新增内容，不用每次重读整个缓冲区。

## 示例

```
> list_targets
- id: R5CT1234/webview_devtools_remote_8812/3A1F…
  app: com.example.app (pid 8812) on SM-S9180
  title: "Order"
  url: https://m.example.com/order

> get_console { "levels": ["error"] }
#41 10:32:01.123 [error exception] TypeError: Cannot read properties of undefined (reading 'price')
    at https://m.example.com/assets/index-8f2a.js:1:48213
next since_seq: 57
```

## 常见问题

- **"no debuggable WebView found"**：App 没有打开 WebView 调试，或者当前没有存活的 WebView。先打开要调试的 H5 页面。
- **"debugger in use"**：一个页面同一时间只能连一个调试器。关掉 `chrome://inspect` 的 DevTools 窗口。
- **"unauthorized"**：在手机上允许 USB 调试授权弹窗。
- **看不到 iOS 页面**：确认装了 `ios_webkit_debug_proxy`、模拟器已启动（或 iPhone 已信任电脑并打开网页检查器）、WKWebView 设置了 `isInspectable`。如果代理装了但没找到页面，`list_targets` 的警告里会说明。

## 已知限制

- **"调试器已占用"的检测不一定准**：它依赖 `/json/list` 里是否缺少 `webSocketDebuggerUrl`。新版 Chromium 允许一个页面同时连多个 CDP 客户端，所以开着 DevTools 时也可能 attach 成功；老版本 WebView 仍可能拒绝。
- **遇到没响应的 App，`list_targets` 每个要多等约 3 秒**：socket 是逐个查询的，超时 3 秒；Android 会冻结后台 App，它们的 WebView socket 就不再响应。`attach` 只重新检查目标页自己的 socket，速度不受影响。
- **`evaluate_js` 拥有页面的全部权限**：能读取 cookie、storage 和 token，也能改变页面状态。请保留 Agent 调用工具前的确认提示。
- **iOS 拿不到 attach 之前的日志**：WebKit 只在有调试器开着 console 时才记录日志，所以要先 attach 再复现问题。Android 会在 attach 时补发最近的日志。
- **iOS 真机还没验证过**：代理本身支持真机，但本项目目前只在 iOS 模拟器上验证过。
- **e2e 测试要求 9333 端口空闲**：如果上次运行留下了 headless Chromium，测试会连到它上面，先把它关掉。

## 开发

e2e 测试用一个假的 `adb` 加 headless Chromium 代替手机：

```bash
npm run build
CHROME=/path/to/chrome npm run test:e2e
```

iOS e2e 测试通过真实的代理驱动已启动模拟器里的 Safari，缺少模拟器或代理时会自动跳过：

```bash
npm run build
npm run test:e2e:ios
```

## 路线图

- [x] 发现设备和 WebView 页面
- [x] console 日志、未捕获异常、浏览器日志
- [ ] 网络请求和响应
- [ ] JSBridge 调用日志（可配置 bridge 形态）
- [x] `evaluate_js`
- [ ] `screenshot`
- [ ] JSBridge mock
- [x] iOS 模拟器（通过 WebKit Inspector Protocol 支持 WKWebView / Safari）
- [ ] iOS 真机（验证）

## 许可证

MIT
