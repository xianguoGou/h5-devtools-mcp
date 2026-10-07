import { findDevtoolsSockets, forwardSocket, getProcessName, listDevices } from "./adb.js";

export interface Target {
  /** Stable id passed to other tools: `<serial>/<socket>/<pageId>`. */
  id: string;
  serial: string;
  model?: string;
  socket: string;
  pid?: number;
  app?: string;
  port: number;
  pageId: string;
  title: string;
  url: string;
  visible?: boolean;
  attachedToWindow?: boolean;
  /** True when another debugger (e.g. chrome://inspect DevTools) is already connected. */
  debuggerInUse: boolean;
  wsUrl: string;
}

interface JsonPage {
  id: string;
  type: string;
  title: string;
  url: string;
  description?: string;
  webSocketDebuggerUrl?: string;
}

const cache = new Map<string, Target>();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function fetchPages(port: number): Promise<JsonPage[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`/json/list returned HTTP ${res.status}`);
  return (await res.json()) as JsonPage[];
}

function appNameFromSocket(socket: string): string | undefined {
  if (socket === "chrome_devtools_remote") return "Chrome browser";
  // Some vendors/apps use "<package>_devtools_remote".
  const m = socket.match(/^(.+)_devtools_remote$/);
  return m && !m[1].startsWith("webview") ? m[1] : undefined;
}

export async function listTargets(): Promise<{ targets: Target[]; warnings: string[] }> {
  const targets: Target[] = [];
  const warnings: string[] = [];

  const devices = await listDevices();
  if (devices.length === 0) {
    warnings.push("No Android devices found. Connect a device with USB debugging enabled and check `adb devices`.");
  }

  for (const device of devices) {
    if (device.state !== "device") {
      const hint = device.state === "unauthorized" ? " — accept the USB debugging prompt on the device" : "";
      warnings.push(`${device.serial}: state "${device.state}"${hint}`);
      continue;
    }

    let sockets;
    try {
      sockets = await findDevtoolsSockets(device.serial);
    } catch (e) {
      warnings.push(`${device.serial}: ${errMsg(e)}`);
      continue;
    }
    if (sockets.length === 0) {
      warnings.push(
        `${device.serial}: no debuggable WebView found. The app must call WebView.setWebContentsDebuggingEnabled(true) and have a WebView alive.`,
      );
      continue;
    }

    for (const socket of sockets) {
      try {
        const port = await forwardSocket(device.serial, socket.name);
        const app =
          (socket.pid ? await getProcessName(device.serial, socket.pid) : undefined) ??
          appNameFromSocket(socket.name);

        for (const page of await fetchPages(port)) {
          if (page.type !== "page") continue;
          let desc: { visible?: boolean; attached?: boolean } = {};
          try {
            desc = page.description ? JSON.parse(page.description) : {};
          } catch {
            // Chrome's description is not JSON; ignore.
          }
          targets.push({
            id: `${device.serial}/${socket.name}/${page.id}`,
            serial: device.serial,
            model: device.model,
            socket: socket.name,
            pid: socket.pid,
            app,
            port,
            pageId: page.id,
            title: page.title,
            url: page.url,
            visible: desc.visible,
            attachedToWindow: desc.attached,
            debuggerInUse: !page.webSocketDebuggerUrl,
            // Build the URL ourselves so it always points at the forwarded port.
            wsUrl: `ws://127.0.0.1:${port}/devtools/page/${page.id}`,
          });
        }
      } catch (e) {
        warnings.push(`${device.serial}/${socket.name}: ${errMsg(e)}`);
      }
    }
  }

  cache.clear();
  for (const t of targets) cache.set(t.id, t);
  return { targets, warnings };
}

/** Look up a target from the last listing, refreshing once if it's not there. */
export async function findTarget(id: string): Promise<Target> {
  let target = cache.get(id);
  if (!target) {
    await listTargets();
    target = cache.get(id);
  }
  if (!target) {
    throw new Error(`Target "${id}" not found. Call list_targets to see current pages; ids change when the app restarts.`);
  }
  return target;
}

export function formatTargets(targets: Target[], warnings: string[]): string {
  const lines: string[] = [];
  if (targets.length === 0) {
    lines.push("No debuggable WebView pages found.");
  } else {
    lines.push(`Found ${targets.length} WebView page(s):`);
    for (const t of targets) {
      const status = [
        t.visible === true ? "visible" : t.visible === false ? "hidden" : undefined,
        t.debuggerInUse ? "debugger in use (close chrome://inspect DevTools to attach)" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        "",
        `- id: ${t.id}`,
        `  app: ${t.app ?? "unknown"}${t.pid ? ` (pid ${t.pid})` : ""} on ${t.model ?? t.serial}`,
        `  title: ${JSON.stringify(t.title)}`,
        `  url: ${t.url}`,
        ...(status ? [`  status: ${status}`] : []),
      );
    }
  }
  if (warnings.length) {
    lines.push("", "Warnings:", ...warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}
