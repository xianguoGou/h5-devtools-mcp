import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fetchPages, type Target } from "./targets.js";

const execFileAsync = promisify(execFile);
const IWDP = process.env.IWDP_PATH || "ios_webkit_debug_proxy";
/** Device ports iwdp may hand out after the list port; one per connected device or simulator. */
const DEVICE_PORT_SPAN = 20;

type ProxyKind = "simulator" | "device";
interface Proxy {
  proc: ChildProcess;
  listPort: number;
  simSocket?: string;
  stderr: string;
}

const proxies = new Map<ProxyKind, Proxy>();
let notInstalled = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The booted simulator's Web Inspector socket. launchd leaves stale sockets behind from earlier
 * sessions, so the only reliable test is connecting to each candidate.
 */
async function liveSimSocket(): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const dir of ["/private/tmp", "/private/var/tmp"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((n) => n.startsWith("com.apple.launchd."));
    } catch {
      continue;
    }
    for (const e of entries) {
      const sock = path.join(dir, e, "com.apple.webinspectord_sim.socket");
      if (existsSync(sock)) candidates.push(sock);
    }
  }
  for (const sock of candidates) {
    const live = await new Promise<boolean>((resolve) => {
      const s = net.connect(sock);
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
      s.setTimeout(300, () => done(false));
    });
    if (live) return sock;
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function listDevices(listPort: number): Promise<{ deviceId: string; deviceName: string; url: string }[]> {
  const res = await fetch(`http://127.0.0.1:${listPort}/json`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()) as { deviceId: string; deviceName: string; url: string }[];
}

/** Returns undefined when iwdp is not installed, so Android-only setups see no iOS noise. */
async function ensureProxy(kind: ProxyKind, simSocket?: string): Promise<Proxy | undefined> {
  const existing = proxies.get(kind);
  if (existing && existing.proc.exitCode === null && existing.simSocket === simSocket) return existing;
  existing?.proc.kill();
  proxies.delete(kind);
  if (notInstalled) return undefined;

  const listPort = await freePort();
  const args = ["-c", `null:${listPort},:${listPort + 1}-${listPort + DEVICE_PORT_SPAN}`];
  if (simSocket) args.push("-s", `unix:${simSocket}`);
  const proc = spawn(IWDP, args, { stdio: ["ignore", "ignore", "pipe"] });
  const proxy: Proxy = { proc, listPort, simSocket, stderr: "" };
  proc.stderr?.on("data", (d) => (proxy.stderr = (proxy.stderr + d).slice(-500)));
  const spawnError = new Promise<Error>((resolve) => proc.once("error", resolve));

  for (let i = 0; i < 30; i++) {
    const err = await Promise.race([spawnError, sleep(100).then(() => undefined)]);
    if (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        notInstalled = true;
        return undefined;
      }
      throw err;
    }
    if (proc.exitCode !== null) throw new Error(`ios_webkit_debug_proxy exited: ${proxy.stderr.trim() || `code ${proc.exitCode}`}`);
    try {
      await listDevices(listPort);
      proxies.set(kind, proxy);
      return proxy;
    } catch {
      // Not listening yet.
    }
  }
  proc.kill();
  throw new Error(`ios_webkit_debug_proxy did not start: ${proxy.stderr.trim() || "no output"}`);
}

/** Simulator apps run as host processes, so the pid in iwdp's appId resolves to the .app name locally. */
async function simAppName(appId?: string): Promise<{ pid?: number; app?: string }> {
  const pid = Number(appId?.match(/^PID:(\d+)$/)?.[1]);
  if (!pid) return { app: appId };
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="]);
    return { pid, app: stdout.match(/\/([^/]+)\.app\//)?.[1] };
  } catch {
    return { pid };
  }
}

export async function listIosTargets(): Promise<{ targets: Target[]; warnings: string[] }> {
  const targets: Target[] = [];
  const warnings: string[] = [];
  const simSocket = await liveSimSocket();
  const kinds: [ProxyKind, string | undefined][] = [["device", undefined]];
  if (simSocket) kinds.push(["simulator", simSocket]);

  let sawDevice = false;
  for (const [kind, sock] of kinds) {
    let proxy: Proxy | undefined;
    const fresh = !proxies.has(kind);
    try {
      proxy = await ensureProxy(kind, sock);
    } catch (e) {
      warnings.push(`iOS ${kind}: ${errMsg(e)}`);
      continue;
    }
    if (!proxy) return { targets, warnings };

    // A freshly started proxy reports devices before their pages; give it a moment.
    for (let attempt = 0; attempt < (fresh ? 15 : 1); attempt++) {
      if (attempt) await sleep(200);
      const found: Target[] = [];
      let devices;
      try {
        devices = await listDevices(proxy.listPort);
      } catch (e) {
        warnings.push(`iOS ${kind}: ${errMsg(e)}`);
        break;
      }
      for (const d of devices) {
        sawDevice = true;
        const port = Number(d.url.split(":").pop());
        let pages;
        try {
          pages = await fetchPages(port);
        } catch (e) {
          if (attempt === (fresh ? 14 : 0)) warnings.push(`iOS ${d.deviceName}: ${errMsg(e)}`);
          continue;
        }
        for (const page of pages) {
          const { pid, app } = await simAppName((page as { appId?: string }).appId);
          found.push({
            id: `ios/${d.deviceId}/${page.id}`,
            platform: "ios",
            serial: d.deviceId,
            model: d.deviceId === "SIMULATOR" ? "iOS Simulator" : d.deviceName,
            socket: "webinspector",
            pid,
            app,
            port,
            pageId: page.id,
            title: page.title,
            url: page.url,
            debuggerInUse: false,
            wsUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}`,
          });
        }
      }
      if (found.length || attempt === (fresh ? 14 : 0)) {
        targets.push(...found);
        break;
      }
    }
  }
  if (sawDevice && targets.length === 0) {
    warnings.push(
      "iOS: no inspectable pages. App WKWebViews need isInspectable = true (iOS 16.4+); on a real device also enable Settings › Safari › Advanced › Web Inspector.",
    );
  }
  return { targets, warnings };
}

export function stopIosProxies() {
  for (const p of proxies.values()) p.proc.kill();
  proxies.clear();
}
process.on("exit", stopIosProxies);
