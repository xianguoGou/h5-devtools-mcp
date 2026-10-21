import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { fetchPages, type Target } from "./targets.js";

const execFileAsync = promisify(execFile);
const IWDP = process.env.IWDP_PATH || "ios_webkit_debug_proxy";
/** Device ports iwdp may hand out after the list port; one per connected device or simulator. */
const DEVICE_PORT_SPAN = 20;
/** Upper bound for the first listing after a proxy starts; it returns as soon as pages show up. */
const FRESH_PROXY_WAIT_MS = 15_000;
/** How long a fresh usbmuxd proxy gets to report a plugged-in iPhone before an empty list counts as none. */
const USB_DISCOVERY_MS = 1_000;

type ProxyKind = "simulator" | "device";
interface Proxy {
  proc: ChildProcess;
  startedAt: number;
  listPort: number;
  simSocket?: string;
  stderr: string;
}

const proxies = new Map<ProxyKind, Proxy>();
/** In-flight starts, so concurrent list_targets / attach calls share one spawn instead of leaking a second. */
const starting = new Map<ProxyKind, Promise<Proxy | undefined>>();
let notInstalled = false;

/** A signal-killed process keeps exitCode null, so check both. */
const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The booted simulator's Web Inspector socket, read from launchd_sim's open files. Don't probe by
 * connecting: a connect-and-close makes webinspectord_sim ignore the next client (measured on the
 * iOS 27 Simulator: iwdp then lists no simulator at all).
 */
async function liveSimSocket(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-c", "launchd_sim", "-U", "-Fn"]);
    return stdout
      .split("\n")
      .find((l) => l.startsWith("n") && l.endsWith("/com.apple.webinspectord_sim.socket"))
      ?.slice(1);
  } catch {
    // lsof exits non-zero when no launchd_sim is running, i.e. no simulator is booted.
    return undefined;
  }
}

function tryListen(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(undefined));
    srv.listen(port, "127.0.0.1", () => {
      const { port: bound } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(bound));
    });
  });
}

/** Port ranges handed to running proxies; their device ports bind lazily, so a free-port probe can't see them. */
const reserved = (p: number) =>
  [...proxies.values()].some((x) => p >= x.listPort && p <= x.listPort + DEVICE_PORT_SPAN);

/** A list port followed by DEVICE_PORT_SPAN free ports, since iwdp binds one port per device. */
async function freePortSpan(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = await tryListen(0);
    if (!base || base + DEVICE_PORT_SPAN > 65535) continue;
    if (reserved(base) || reserved(base + DEVICE_PORT_SPAN)) continue;
    let ok = true;
    for (let p = base + 1; p <= base + DEVICE_PORT_SPAN && ok; p++) ok = (await tryListen(p)) !== undefined;
    if (ok) return base;
  }
  throw new Error("no free port range for ios_webkit_debug_proxy");
}

async function listDevices(listPort: number): Promise<{ deviceId: string; deviceName: string; url: string }[]> {
  const res = await fetch(`http://127.0.0.1:${listPort}/json`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()) as { deviceId: string; deviceName: string; url: string }[];
}

/** Returns undefined when iwdp is not installed, so Android-only setups see no iOS noise. */
function ensureProxy(kind: ProxyKind, simSocket?: string): Promise<Proxy | undefined> {
  const inFlight = starting.get(kind);
  if (inFlight) return inFlight;
  const existing = proxies.get(kind);
  if (existing && alive(existing.proc) && existing.simSocket === simSocket) return Promise.resolve(existing);
  existing?.proc.kill();
  proxies.delete(kind);
  if (notInstalled) return Promise.resolve(undefined);
  const start = startProxy(kind, simSocket).finally(() => starting.delete(kind));
  starting.set(kind, start);
  return start;
}

async function startProxy(kind: ProxyKind, simSocket?: string): Promise<Proxy | undefined> {
  const listPort = await freePortSpan();
  const args = ["-c", `null:${listPort},:${listPort + 1}-${listPort + DEVICE_PORT_SPAN}`];
  if (simSocket) args.push("-s", `unix:${simSocket}`);
  const proc = spawn(IWDP, args, { stdio: ["ignore", "ignore", "pipe"] });
  // Don't let the proxy keep the server alive once the MCP client is gone.
  proc.unref();
  (proc.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  const proxy: Proxy = { proc, startedAt: Date.now(), listPort, simSocket, stderr: "" };
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
    if (!alive(proc)) {
      throw new Error(`ios_webkit_debug_proxy exited: ${proxy.stderr.trim() || `${proc.exitCode ?? proc.signalCode}`}`);
    }
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
  else {
    // Simulator shut down: its proxy has nothing left to talk to.
    proxies.get("simulator")?.proc.kill();
    proxies.delete("simulator");
  }

  // Start proxies one at a time (port ranges are picked against the ones already running), then
  // poll them in parallel so a slow simulator doesn't hold up the USB devices or the other way round.
  const started: [ProxyKind, Proxy][] = [];
  for (const [kind, sock] of kinds) {
    try {
      const proxy = await ensureProxy(kind, sock);
      if (!proxy) return { targets, warnings };
      started.push([kind, proxy]);
    } catch (e) {
      warnings.push(`iOS ${kind}: ${errMsg(e)}`);
    }
  }

  let sawDevice = false;
  const perKind = await Promise.all(
    started.map(async ([kind, proxy]) => {
      const targets: Target[] = [];
      const warnings: string[] = [];
      // A freshly started proxy lists pages after 0.4s, or ~10.5s when another inspector client
      // disconnected shortly before (iOS 27 Simulator, both SIGKILL and SIGTERM). Keyed to the proxy's
      // start time, so a concurrent call that finds it already running waits for the same window.
      const deadline = proxy.startedAt + FRESH_PROXY_WAIT_MS;
      for (let attempt = 0; ; attempt++) {
        if (attempt) await sleep(200);
        const last = Date.now() >= deadline;
        const found: Target[] = [];
        let devices;
        try {
          // iwdp can report one iPhone twice (USB and Wi-Fi); keep the first.
          devices = (await listDevices(proxy.listPort)).filter(
            (d, i, all) => all.findIndex((x) => x.deviceId === d.deviceId) === i,
          );
        } catch (e) {
          warnings.push(`iOS ${kind}: ${errMsg(e)}`);
          break;
        }
        // No iPhone plugged in is the common case: give usbmuxd discovery a second, then stop waiting.
        // The simulator socket is known to be live, so keep waiting there.
        if (devices.length === 0 && kind === "device" && Date.now() >= proxy.startedAt + USB_DISCOVERY_MS) break;
        for (const d of devices) {
          sawDevice = true;
          const port = Number(d.url.split(":").pop());
          let pages;
          try {
            pages = await fetchPages(port);
          } catch (e) {
            if (last) warnings.push(`iOS ${d.deviceName}: ${errMsg(e)}`);
            continue;
          }
          for (const page of pages) {
            const appId = (page as { appId?: string }).appId;
            // Only simulator apps are host processes; a device pid means nothing on this Mac.
            const { pid, app } = d.deviceId === "SIMULATOR" ? await simAppName(appId) : { pid: undefined, app: appId };
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
        if (found.length || last) {
          targets.push(...found);
          break;
        }
      }
      return { targets, warnings };
    }),
  );
  for (const r of perKind) {
    targets.push(...r.targets);
    warnings.push(...r.warnings);
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
