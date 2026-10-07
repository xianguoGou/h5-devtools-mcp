// End-to-end test without a phone: a fake adb + headless Chromium stand in for a device WebView.
// Usage: CHROME=/path/to/chrome node test/e2e/run.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const PORT = "9333";
const chromeBin = process.env.CHROME;
if (!chromeBin) throw new Error("Set CHROME to a Chrome/Chromium binary");

const chrome = spawn(chromeBin, [
  "--headless", "--no-sandbox", `--remote-debugging-port=${PORT}`,
  `file://${path.join(dir, "page.html")}`,
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "dist/index.js")],
  env: { ...process.env, ADB_PATH: path.join(dir, "fake-adb.sh"), FAKE_PORT: PORT },
});
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n===== ${name} ${JSON.stringify(args)}${r.isError ? " (isError)" : ""} =====\n${r.content[0].text}`);
  return r.content[0].text;
};

try {
  const list = await call("list_targets");
  const id = list.match(/- id: (\S+)/)?.[1];
  if (!id) throw new Error("no target found");
  await call("attach", { target_id: id });
  await sleep(1500);
  const out = await call("get_console", { limit: 5 });
  await call("get_console", { levels: ["warn", "error"] });
  const next = Number(out.match(/next since_seq: (\d+)/)[1]);
  await sleep(500);
  await call("get_console", { since_seq: next });
  await call("detach");
} finally {
  await client.close();
  chrome.kill();
}
