import CDP from "chrome-remote-interface";
import type { Protocol } from "devtools-protocol";
import { RingBuffer } from "./ringBuffer.js";
import type { Target } from "./targets.js";

export const CONSOLE_LEVELS = ["debug", "log", "info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export interface ConsoleEntry {
  seq: number;
  time: number;
  level: ConsoleLevel;
  /** console = console.* calls, exception = uncaught errors, browser = engine messages (network errors, violations…) */
  source: "console" | "exception" | "browser";
  text: string;
  location?: string;
}

const MAX_TEXT = 1000;
const BUFFER_SIZE = 1000;

function truncate(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

function formatPreview(p: Protocol.Runtime.ObjectPreview): string {
  const isArray = p.subtype === "array";
  const props = p.properties.map((prop) => {
    const v = prop.type === "string" ? JSON.stringify(prop.value) : (prop.value ?? prop.type);
    return isArray ? v : `${prop.name}: ${v}`;
  });
  if (p.overflow) props.push("…");
  return isArray ? `[${props.join(", ")}]` : `{${props.join(", ")}}`;
}

function formatArg(o: Protocol.Runtime.RemoteObject): string {
  if (o.type === "string") return String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.value !== undefined) return JSON.stringify(o.value);
  if (o.preview && o.type === "object" && o.subtype !== "error") return formatPreview(o.preview);
  return o.description ?? o.type;
}

function formatFrame(frame?: Protocol.Runtime.CallFrame): string | undefined {
  if (!frame?.url) return undefined;
  return `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
}

function normalizeConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case "error":
    case "assert":
      return "error";
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "debug":
      return "debug";
    default:
      return "log";
  }
}

function normalizeLogLevel(level: string): ConsoleLevel {
  if (level === "error") return "error";
  if (level === "warning") return "warn";
  if (level === "verbose") return "debug";
  return "info";
}

export class Session {
  readonly console = new RingBuffer<ConsoleEntry>(BUFFER_SIZE);
  closed = false;
  closeReason?: string;

  private constructor(
    readonly target: Target,
    private readonly client: CDP.Client,
  ) {}

  static async open(target: Target): Promise<Session> {
    if (target.debuggerInUse) {
      throw new Error(
        "This page already has a debugger attached (usually chrome://inspect DevTools). Close it and call attach again.",
      );
    }
    // local: true — use the bundled protocol descriptor; WebViews may not serve /json/protocol.
    const client = await CDP({ target: target.wsUrl, local: true });
    const session = new Session(target, client);
    session.wire();
    await client.Runtime.enable();
    try {
      await client.Log.enable();
    } catch {
      // Log domain is optional; console + exceptions still work without it.
    }
    return session;
  }

  private wire() {
    const { client } = this;

    client.Runtime.consoleAPICalled((e) => {
      this.console.push({
        time: e.timestamp || Date.now(),
        level: normalizeConsoleType(e.type),
        source: "console",
        text: truncate(e.args.map(formatArg).join(" ")),
        location: formatFrame(e.stackTrace?.callFrames[0]),
      });
    });

    client.Runtime.exceptionThrown((e) => {
      const d = e.exceptionDetails;
      const text = d.exception?.description ?? d.text;
      this.console.push({
        time: e.timestamp || Date.now(),
        level: "error",
        source: "exception",
        text: truncate(text),
        location:
          formatFrame(d.stackTrace?.callFrames[0]) ??
          (d.url ? `${d.url}:${d.lineNumber + 1}:${d.columnNumber + 1}` : undefined),
      });
    });

    client.Log.entryAdded(({ entry }) => {
      this.console.push({
        time: entry.timestamp || Date.now(),
        level: normalizeLogLevel(entry.level),
        source: "browser",
        text: truncate(`[${entry.source}] ${entry.text}`),
        location: entry.url ? `${entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : ""}` : undefined,
      });
    });

    client.on("disconnect", () => {
      this.closed = true;
      this.closeReason ??= "connection lost (page closed, app killed, or device disconnected)";
    });
  }

  async close(reason = "detached") {
    if (this.closed) return;
    this.closeReason = reason;
    this.closed = true;
    await this.client.close().catch(() => {});
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private lastId?: string;

  async attach(target: Target): Promise<{ session: Session; reused: boolean }> {
    const existing = this.sessions.get(target.id);
    if (existing && !existing.closed) {
      this.lastId = target.id;
      return { session: existing, reused: true };
    }
    const session = await Session.open(target);
    this.sessions.set(target.id, session);
    this.lastId = target.id;
    return { session, reused: false };
  }

  /** Get a session by id, or the most recently attached one. */
  get(id?: string): Session {
    const key = id ?? this.lastId;
    if (!key) throw new Error("No page attached. Call list_targets, then attach.");
    const session = this.sessions.get(key);
    if (!session) throw new Error(`Not attached to "${key}". Call attach first.`);
    return session;
  }

  async detach(id?: string): Promise<Session> {
    const session = this.get(id);
    await session.close();
    this.sessions.delete(session.target.id);
    if (this.lastId === session.target.id) this.lastId = undefined;
    return session;
  }

  async closeAll() {
    await Promise.all([...this.sessions.values()].map((s) => s.close("server shutting down")));
    this.sessions.clear();
  }
}
