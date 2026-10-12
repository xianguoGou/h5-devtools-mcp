# h5-devtools-mcp

[![npm version](https://img.shields.io/npm/v/h5-devtools-mcp.svg)](https://www.npmjs.com/package/h5-devtools-mcp)
[![npm downloads](https://img.shields.io/npm/dm/h5-devtools-mcp.svg)](https://www.npmjs.com/package/h5-devtools-mcp)
[![license](https://img.shields.io/npm/l/h5-devtools-mcp.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

An MCP server that lets coding agents (Claude Code, Codex, Cursor…) debug **H5 pages running inside Android WebViews on real devices** — read console output and uncaught exceptions, and run JavaScript in the page, without opening `chrome://inspect`.

> Status: v0.1, early. Android only.

## How it works

```
Coding agent ──MCP (stdio)──▶ h5-devtools-mcp ──adb forward──▶ webview_devtools_remote_<pid> ──CDP──▶ WebView page
```

Every debuggable WebView exposes a Chrome DevTools Protocol endpoint on an abstract unix socket. The server discovers those sockets over adb (the same way `chrome://inspect` does), forwards them to local ports, and connects with CDP.

## Requirements

- Node.js 18+
- `adb` on your `PATH` (or set `ADB_PATH`)
- An Android device with USB debugging enabled
- The app must enable WebView debugging (debug builds usually do):

```java
WebView.setWebContentsDebuggingEnabled(true);
```

## Setup

```bash
# Claude Code
claude mcp add h5-devtools -- npx -y h5-devtools-mcp
```

Other MCP clients (Cursor, Codex…) take the same command: `npx -y h5-devtools-mcp`.

### From source

```bash
git clone https://github.com/xianguoGou/h5-devtools-mcp.git
cd h5-devtools-mcp
npm install && npm run build
claude mcp add h5-devtools -- node /absolute/path/to/h5-devtools-mcp/dist/index.js
```

## Tools

| Tool | What it does |
|---|---|
| `list_targets` | List debuggable pages: app package, title, URL, visibility |
| `attach` | Connect to a page and start buffering console output |
| `get_console` | Read buffered entries, filtered by level / keyword / `exclude_keywords`, incrementally via `since_seq` |
| `evaluate_js` | Run a JavaScript expression in the page and return the result (promises are awaited) |
| `detach` | Disconnect from a page |

Output is designed to be token-cheap: compact one-line entries, long messages truncated, and `since_seq` so an agent only reads what's new instead of re-reading the whole buffer on every turn.

## Example

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

## Troubleshooting

- **"no debuggable WebView found"** — the app hasn't enabled WebView debugging, or no WebView is alive yet. Open the H5 page first.
- **"debugger in use"** — only one debugger can attach to a page. Close the `chrome://inspect` DevTools window.
- **"unauthorized"** — accept the USB debugging prompt on the device.

## Known limitations

- **Debugger-in-use detection is best-effort.** It relies on `/json/list` omitting `webSocketDebuggerUrl`. Recent Chromium accepts several CDP clients per page, so attach may succeed alongside an open DevTools window; older WebViews may still refuse.
- **`list_targets` can take ~3s per unresponsive app.** Sockets are queried one by one with a 3s timeout, and Android freezes background apps, so their WebView sockets stop answering. `attach` only re-checks the target's own socket and stays fast.
- **`evaluate_js` runs with the page's full privileges** — it can read cookies, storage and tokens, and change page state. Keep it behind your agent's tool-permission prompt.
- **The e2e script expects port 9333 to be free.** If a previous run left a headless Chromium behind, it attaches to that one; kill it first.

## Development

The e2e test uses a fake `adb` and headless Chromium in place of a phone:

```bash
npm run build
CHROME=/path/to/chrome npm run test:e2e
```

## Roadmap

- [x] Discover devices and WebView pages
- [x] Console messages, uncaught exceptions, browser log entries
- [ ] Network requests and responses
- [ ] JSBridge call logging (configurable bridge shapes)
- [x] `evaluate_js`
- [ ] `screenshot`
- [ ] JSBridge mocking
- [ ] iOS (WKWebView via WebKit Inspector Protocol)

## License

MIT
