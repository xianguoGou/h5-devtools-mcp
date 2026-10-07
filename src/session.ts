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
/** Caps the CDP round-trips spent fetching previews on attach; older replayed objects print as "Object". */
const MAX_REPLAY_PREVIEWS = 200;
const PREVIEW_GROUP = "h5-devtools-preview";
const MAX_EVAL_TEXT = 4000;
const EVAL_TIMEOUT_MS = 10_000;
const EVAL_GROUP = "h5-devtools-eval";

type PendingEntry = { entry: Omit<ConsoleEntry, "seq">; args?: Protocol.Runtime.RemoteObject[] };

const needsPreview = (o: Protocol.Runtime.RemoteObject) =>
  !o.preview && !!o.objectId && o.type === "object" && o.subtype !== "error";

function truncate(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

function formatPreview(p: Protocol.Runtime.ObjectPreview): string {
  // Map/Set contents live in `entries`, not `properties`.
  if (p.entries) {
    const text = (v: Protocol.Runtime.ObjectPreview) => (v.type === "string" ? JSON.stringify(v.description) : v.description);
    const items = p.entries.map((e) => (e.key ? `${text(e.key)} => ${text(e.value)}` : text(e.value)));
    if (p.overflow) items.push("…");
    return `${p.description ?? ""} {${items.join(", ")}}`;
  }
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

const formatArgs = (args: Protocol.Runtime.RemoteObject[]) => truncate(args.map(formatArg).join(" "));

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
    let client: CDP.Client;
    try {
      // local: true — use the bundled protocol descriptor; WebViews may not serve /json/protocol.
      client = await CDP({ target: target.wsUrl, local: true });
    } catch (e) {
      throw new Error(
        `Could not connect to the page (${e instanceof Error ? e.message : String(e)}). It may have closed; call list_targets and attach again.`,
        { cause: e },
      );
    }
    const session = new Session(target, client);
    session.wire();
    try {
      await client.Runtime.enable();
      try {
        await client.Log.enable();
      } catch {
        // Log domain is optional; console + exceptions still work without it.
      }
      await session.flushReplay();
    } catch (e) {
      // Release the socket, or single-client WebViews stay locked as "debugger in use".
      await client.close().catch(() => {});
      throw e;
    }
    return session;
  }

  /**
   * Runtime.enable and Log.enable each replay their own history, so the two streams arrive
   * out of order. Hold replayed entries here and assign seqs only after sorting by time.
   */
  private replay?: PendingEntry[] = [];

  private add(entry: Omit<ConsoleEntry, "seq">, args?: Protocol.Runtime.RemoteObject[]) {
    if (this.replay) this.replay.push({ entry, args });
    else this.console.push(entry);
  }

  /** Replayed console args carry no preview (only live ones do), so fetch it for the most recent ones. */
  private async flushReplay() {
    const pending = this.replay ?? [];
    const toPreview = pending.filter((p) => p.args?.some(needsPreview)).slice(-MAX_REPLAY_PREVIEWS);
    await Promise.all(
      toPreview.map(async (p) => {
        p.entry.text = formatArgs(await Promise.all(p.args!.map((a) => this.withPreview(a))));
      }),
    );
    if (toPreview.length) await this.client.Runtime.releaseObjectGroup({ objectGroup: PREVIEW_GROUP }).catch(() => {});
    // Live events that arrived during the awaits above were appended to `pending` too.
    this.replay = undefined;
    pending.sort((a, b) => a.entry.time - b.entry.time);
    for (const p of pending) this.console.push(p.entry);
  }

  private async withPreview(o: Protocol.Runtime.RemoteObject): Promise<Protocol.Runtime.RemoteObject> {
    if (!needsPreview(o)) return o;
    try {
      const { result } = await this.client.Runtime.callFunctionOn({
        objectId: o.objectId,
        functionDeclaration: "function () { return this; }",
        generatePreview: true,
        objectGroup: PREVIEW_GROUP,
      });
      return result;
    } catch {
      return o;
    }
  }

  private wire() {
    const { client } = this;

    client.Runtime.consoleAPICalled((e) => {
      this.add(
        {
          time: e.timestamp || Date.now(),
          level: normalizeConsoleType(e.type),
          source: "console",
          text: formatArgs(e.args),
          location: formatFrame(e.stackTrace?.callFrames[0]),
        },
        e.args,
      );
    });

    client.Runtime.exceptionThrown((e) => {
      const d = e.exceptionDetails;
      const text = d.exception?.description ?? d.text;
      this.add({
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
      this.add({
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

  private evalCount = 0;

  /** Evaluate an expression in the page and return a compact text rendering of the result. */
  async evaluate(expression: string): Promise<{ text: string; isError: boolean }> {
    if (this.closed) throw new Error(`Session closed: ${this.closeReason}. Re-run list_targets and attach.`);
    // One group per call, so a finishing call can't release objects a concurrent call still uses.
    const objectGroup = `${EVAL_GROUP}-${++this.evalCount}`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Evaluation did not finish within ${EVAL_TIMEOUT_MS / 1000}s (it may still be running in the page).`)),
        EVAL_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([this.evaluateInGroup(expression, objectGroup), timeout]);
    } finally {
      clearTimeout(timer);
      await this.client.Runtime.releaseObjectGroup({ objectGroup }).catch(() => {});
    }
  }

  private async evaluateInGroup(expression: string, objectGroup: string): Promise<{ text: string; isError: boolean }> {
    const { result, exceptionDetails } = await this.client.Runtime.evaluate({
      expression,
      awaitPromise: true,
      generatePreview: true,
      userGesture: true,
      objectGroup,
    });
    if (exceptionDetails) {
      // Thrown primitives (throw "x") carry a value and no description.
      const d = exceptionDetails;
      return { text: truncate(d.exception ? formatArg(d.exception) : d.text, MAX_EVAL_TEXT), isError: true };
    }
    return { text: await this.renderValue(result), isError: false };
  }

  /**
   * returnByValue turns DOM nodes, Maps and Errors into {} and throws on window, so only plain
   * objects/arrays are JSON-serialized (in the page); everything else uses its description or preview.
   */
  private async renderValue(o: Protocol.Runtime.RemoteObject): Promise<string> {
    if (o.type === "undefined") return "undefined";
    if (o.subtype === "node") return o.description ?? "node";
    if (o.objectId && o.type === "object" && (!o.subtype || o.subtype === "array")) {
      // Truncate in the page so a huge array isn't shipped over USB only to be cut here.
      const { result } = await this.client.Runtime.callFunctionOn({
        objectId: o.objectId,
        functionDeclaration: `function () {
          const s = JSON.stringify(this, null, 2);
          return typeof s === "string" && s.length > ${MAX_EVAL_TEXT} ? s.slice(0, ${MAX_EVAL_TEXT}) + "… [+" + (s.length - ${MAX_EVAL_TEXT}) + " chars]" : s;
        }`,
        returnByValue: true,
      });
      // Cyclic objects (e.g. window) make JSON.stringify throw; fall back to the preview.
      if (typeof result.value === "string") return result.value;
    }
    return truncate(formatArg(o), MAX_EVAL_TEXT);
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
