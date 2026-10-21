// End-to-end test on a booted iOS Simulator: Safari loads a local page, the server reaches it
// through ios_webkit_debug_proxy. Skips (exit 0) when no simulator is booted or iwdp is missing.
// Usage: npm run build && node test/e2e/run-ios.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = (why) => {
  console.log(`SKIP: ${why}`);
  process.exit(0);
};

try {
  execFileSync("which", ["ios_webkit_debug_proxy"]);
} catch {
  skip("ios_webkit_debug_proxy not installed");
}
if (!/\(Booted\)/.test(execFileSync("xcrun", ["simctl", "list", "devices", "booted"]).toString())) skip("no booted iOS Simulator");

const page = readFileSync(path.join(dir, "ios-page.html"));
const server = http.createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const first = `http://127.0.0.1:${port}/?first=${Date.now()}`;
execFileSync("xcrun", ["simctl", "openurl", "booted", first]);
await sleep(2000);

const transport = new StdioClientTransport({ command: "node", args: [path.join(root, "dist/index.js")] });
const client = new Client({ name: "e2e-ios", version: "0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n===== ${name} ${JSON.stringify(args)}${r.isError ? " (isError)" : ""} =====\n${r.content[0].text}`);
  return { text: r.content[0].text, isError: !!r.isError };
};
const expect = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
};

try {
  const { text: list } = await call("list_targets");
  const block = list.split("\n- ").find((b) => b.includes(first));
  const id = block?.match(/id: (ios\/\S+)/)?.[1];
  expect(id, "list_targets shows the Safari page with an ios/ id");
  expect(block.includes("on iOS Simulator"), "target reports the iOS Simulator");

  await call("attach", { target_id: id });
  // WebKit keeps no console history from before an inspector attached, so reproduce after attach.
  await call("evaluate_js", { expression: "location.reload(); 1" });
  await sleep(1500);
  const { text: all } = await call("get_console");
  expect(/\[log\] boot \{symbol: "AAPL", qty: 10\} \[1, 2, 3\]/.test(all), "console.log with object/array previews");
  expect(all.includes("[warn] slow bridge response"), "console.warn");
  expect(/\[error exception\] ReferenceError: Can't find variable: undefinedFn/.test(all), "uncaught exception captured");

  await call("detach");
  await call("attach", { target_id: id });
  await sleep(500);
  const { text: replayed } = await call("get_console");
  expect(replayed.includes("[warn] slow bridge response"), "re-attach replays what was captured while attached");
  expect(replayed.includes('boot {symbol: "AAPL", qty: 10} [1, 2, 3]'), "replayed objects get previews");

  expect((await call("evaluate_js", { expression: "document.title" })).text === "iOS Order", "evaluate returns a string");
  const p = await call("evaluate_js", { expression: "Promise.resolve({ ok: true, n: 2 })" });
  expect(!p.isError && p.text.includes('"ok": true'), "evaluate awaits promises and returns JSON");
  expect((await call("evaluate_js", { expression: "new Map([[1, 2]])" })).text.startsWith("Map"), "evaluate describes a Map");
  const thrown = await call("evaluate_js", { expression: "missingVar.x" });
  expect(thrown.isError && thrown.text.includes("missingVar"), "evaluate reports thrown errors");
  const rejected = await call("evaluate_js", { expression: "Promise.reject(new Error('nope'))" });
  expect(rejected.isError && rejected.text.includes("nope"), "evaluate reports rejected promises");

  const next = Number(all.match(/next since_seq: (\d+)/)[1]);
  // localhost vs 127.0.0.1 is a different origin, so WebKit swaps in a new process and target.
  const second = `http://localhost:${port}/?second=1`;
  await call("evaluate_js", { expression: `location.href = ${JSON.stringify(second)}; 1` });
  await sleep(3000);
  const { text: after } = await call("get_console", { since_seq: next });
  expect(after.includes(`(${second})`), "header shows the url after cross-origin navigation");
  expect(after.includes('[log] boot {symbol: "AAPL", qty: 10} [1, 2, 3]'), "console keeps flowing (with previews) after the target swap");

  await call("detach");
  console.log("\nPASS");
} finally {
  await client.close();
  server.close();
}
