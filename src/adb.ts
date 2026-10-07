import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ADB = process.env.ADB_PATH || "adb";

export class AdbError extends Error {}

async function adb(args: string[], serial?: string): Promise<string> {
  const fullArgs = serial ? ["-s", serial, ...args] : args;
  try {
    const { stdout } = await execFileAsync(ADB, fullArgs, {
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new AdbError(
        `adb not found ("${ADB}"). Install Android platform-tools or set the ADB_PATH environment variable.`,
      );
    }
    const stderr = String(err?.stderr ?? "").trim();
    throw new AdbError(`adb ${fullArgs.join(" ")} failed: ${stderr || err?.message}`);
  }
}

export interface Device {
  serial: string;
  /** "device" when usable; otherwise e.g. "unauthorized", "offline". */
  state: string;
  model?: string;
}

export async function listDevices(): Promise<Device[]> {
  const out = await adb(["devices", "-l"]);
  return out
    .split("\n")
    .slice(1) // "List of devices attached"
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("*"))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const model = rest.find((r) => r.startsWith("model:"))?.slice("model:".length);
      return { serial, state, model };
    });
}

export interface DevtoolsSocket {
  /** Abstract unix socket name without the leading "@". */
  name: string;
  pid?: number;
}

/**
 * Every debuggable WebView process exposes an abstract unix socket named
 * `webview_devtools_remote_<pid>` (Chrome uses `chrome_devtools_remote`).
 * This is the same discovery mechanism chrome://inspect uses.
 */
export async function findDevtoolsSockets(serial: string): Promise<DevtoolsSocket[]> {
  const out = await adb(["shell", "cat", "/proc/net/unix"], serial);
  const names = new Set<string>();
  for (const match of out.matchAll(/@(\S*devtools_remote\S*)/g)) {
    names.add(match[1]);
  }
  return [...names].map((name) => {
    const pid = name.match(/^webview_devtools_remote_(\d+)$/)?.[1];
    return { name, pid: pid ? Number(pid) : undefined };
  });
}

/** Resolve a pid to its process name, which for app processes is the package name. */
export async function getProcessName(serial: string, pid: number): Promise<string | undefined> {
  try {
    const out = await adb(["shell", "cat", `/proc/${pid}/cmdline`], serial);
    const name = out.split("\0")[0].trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Forward a device socket to a local TCP port, reusing an existing forward when possible. */
export async function forwardSocket(serial: string, socketName: string): Promise<number> {
  const list = await adb(["forward", "--list"]);
  for (const line of list.split("\n")) {
    const [s, local, remote] = line.trim().split(/\s+/);
    if (s === serial && remote === `localabstract:${socketName}` && local?.startsWith("tcp:")) {
      return Number(local.slice("tcp:".length));
    }
  }
  // tcp:0 asks adb to pick a free port and print it.
  const out = await adb(["forward", "tcp:0", `localabstract:${socketName}`], serial);
  const port = Number(out.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new AdbError(`Unexpected output from adb forward: "${out.trim()}"`);
  }
  return port;
}
