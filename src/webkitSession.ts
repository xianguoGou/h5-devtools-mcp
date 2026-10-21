import WebSocket from "ws";
import { RingBuffer } from "./ringBuffer.js";
import { currentPageInfo, type Target } from "./targets.js";
import {
  BUFFER_SIZE,
  MAX_EVAL_TEXT,
  truncate,
  withEvalTimeout,
  type ConsoleEntry,
  type ConsoleLevel,
  type PageSession,
} from "./format.js";

const COMMAND_TIMEOUT_MS = 5_000;
/** iOS before Target-based inspection (pre 12.2-ish) never announces a target; fall back to direct commands. */
const TARGET_WAIT_MS = 1_000;
const EVAL_GROUP = "h5-devtools-eval";
/** Caps the round-trips spent fetching previews for replayed messages; older ones print as "Object". */
const MAX_REPLAY_PREVIEWS = 200;

// Subset of the WebKit Inspector protocol this file reads.
interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
}
interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: { name: string; type: string; subtype?: string; value?: string; valuePreview?: ObjectPreview }[];
  entries?: { key?: ObjectPreview; value: ObjectPreview }[];
}
interface CallFrame {
  url?: string;
  lineNumber: number;
  columnNumber: number;
}
interface ConsoleMessage {
  source: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp?: number;
  parameters?: RemoteObject[];
  // Newer WebKit wraps frames in an object; older sends the array directly.
  stackTrace?: { callFrames?: CallFrame[] } | CallFrame[];
}

function formatPreview(p: ObjectPreview): string {
  if (p.entries) {
    const text = (v: ObjectPreview) => v.description ?? v.type;
    const items = p.entries.map((e) => (e.key ? `${text(e.key)} => ${text(e.value)}` : text(e.value)));
    if (p.overflow) items.push("…");
    return `${p.description ?? ""} {${items.join(", ")}}`;
  }
  const isArray = p.subtype === "array";
  const props = (p.properties ?? []).map((prop) => {
    const v = prop.type === "string" ? JSON.stringify(prop.value) : (prop.value ?? prop.valuePreview?.description ?? prop.type);
    return isArray ? v : `${prop.name}: ${v}`;
  });
  if (p.overflow) props.push("…");
  return isArray ? `[${props.join(", ")}]` : `{${props.join(", ")}}`;
}

function formatArg(o: RemoteObject): string {
  if (o.type === "string") return String(o.value);
  if (o.type === "undefined") return "undefined";
  if (o.subtype === "null") return "null";
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.preview && o.type === "object" && o.subtype !== "error") return formatPreview(o.preview);
  return o.description ?? o.type;
}

const needsPreview = (o: RemoteObject) =>
  !o.preview && !!o.objectId && o.type === "object" && o.subtype !== "error" && o.subtype !== "null";

type PendingEntry = { entry: Omit<ConsoleEntry, "seq">; params?: RemoteObject[] };

function normalizeLevel(level: string): ConsoleLevel {
  if (level === "error") return "error";
  if (level === "warning") return "warn";
  if (level === "info") return "info";
  if (level === "debug") return "debug";
  return "log";
}

// WebKit reports a literal "undefined" url for code without a script url (e.g. evaluated code).
const hasUrl = (url?: string): url is string => !!url && url !== "undefined";

/** WebKit console line/column numbers are 1-based, unlike CDP. */
function formatLocation(m: ConsoleMessage): string | undefined {
  const frames = Array.isArray(m.stackTrace) ? m.stackTrace : m.stackTrace?.callFrames;
  const f = frames?.find((c) => hasUrl(c.url));
  if (f) return `${f.url}:${f.lineNumber}:${f.columnNumber}`;
  if (hasUrl(m.url)) return `${m.url}${m.line ? `:${m.line}:${m.column ?? 0}` : ""}`;
  return undefined;
}

interface Pending {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** iOS WKWebView / Safari page over the WebKit Inspector protocol, via ios_webkit_debug_proxy. */
export class WebKitSession implements PageSession {
  readonly console = new RingBuffer<ConsoleEntry>(BUFFER_SIZE);
  closed = false;
  closeReason?: string;

  private nextId = 0;
  private pending = new Map<number, Pending>();
  /** Outer Target.sendMessageToTarget id → inner command id, so a routing error fails the right call. */
  private outer = new Map<number, number>();
  private targetId?: string;
  private evalCount = 0;

  private constructor(
    public target: Target,
    private readonly ws: WebSocket,
  ) {}

  static async open(target: Target): Promise<WebKitSession> {
    const ws = new WebSocket(target.wsUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
    } catch (e) {
      throw new Error(
        `Could not connect to the page (${e instanceof Error ? e.message : String(e)}). It may have closed; call list_targets and attach again.`,
        { cause: e },
      );
    }
    const session = new WebKitSession(target, ws);
    const announced = new Promise<void>((resolve) => {
      session.onTarget = resolve;
      setTimeout(resolve, TARGET_WAIT_MS);
    });
    session.wire();
    await announced;
    try {
      await session.enable();
    } catch (e) {
      ws.close();
      throw e;
    }
    return session;
  }

  private onTarget?: () => void;

  /** Set while Console.enable replays history: replayed objects carry no preview, so hold them until fetched. */
  private replay?: PendingEntry[];

  private async enable() {
    this.replay = [];
    try {
      // Console.enable replays only what was logged while some inspector had Console enabled;
      // unlike Chromium, messages from before the first attach are gone.
      await Promise.all([this.send("Console.enable"), this.send("Runtime.enable")]);
    } finally {
      await this.flushReplay();
    }
  }

  private async flushReplay() {
    const pending = this.replay ?? [];
    const toPreview = pending.filter((p) => p.params?.some(needsPreview)).slice(-MAX_REPLAY_PREVIEWS);
    await Promise.all(
      toPreview.map(async (p) => {
        const params = await Promise.all(
          p.params!.map(async (o) => {
            if (!needsPreview(o)) return o;
            const r = await this.send("Runtime.getPreview", { objectId: o.objectId }).catch(() => undefined);
            return r?.preview ? { ...o, preview: r.preview } : o;
          }),
        );
        p.entry.text = truncate(params.map(formatArg).join(" "));
      }),
    );
    // Live messages that arrived during the awaits above were appended to `pending` too.
    this.replay = undefined;
    for (const p of pending) this.console.push(p.entry);
  }

  private add(entry: Omit<ConsoleEntry, "seq">, params?: RemoteObject[]) {
    if (this.replay) this.replay.push({ entry, params });
    else this.console.push(entry);
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`Session closed: ${this.closeReason}. Re-run list_targets and attach.`));
    const id = ++this.nextId;
    const inner = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      if (this.targetId) {
        const outerId = ++this.nextId;
        this.outer.set(outerId, id);
        this.ws.send(
          JSON.stringify({
            id: outerId,
            method: "Target.sendMessageToTarget",
            params: { targetId: this.targetId, message: JSON.stringify(inner) },
          }),
        );
      } else {
        this.ws.send(JSON.stringify(inner));
      }
    });
  }

  private settle(msg: { id: number; result?: unknown; error?: { message: string } }) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private wire() {
    this.ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const innerId = this.outer.get(msg.id);
        if (innerId !== undefined) {
          this.outer.delete(msg.id);
          if (msg.error) this.settle({ id: innerId, error: msg.error });
          return;
        }
        this.settle(msg);
        return;
      }
      switch (msg.method) {
        case "Target.targetCreated": {
          const info = msg.params.targetInfo;
          if (!this.targetId && !info.isProvisional) {
            this.targetId = info.targetId;
            this.onTarget?.();
          }
          break;
        }
        case "Target.didCommitProvisionalTarget":
          // Cross-origin navigation swaps the page into a new process with a new target.
          if (msg.params.oldTargetId === this.targetId) {
            this.targetId = msg.params.newTargetId;
            this.enable().catch(() => {});
          }
          break;
        case "Target.targetDestroyed":
          if (msg.params.targetId === this.targetId) this.markClosed("page closed");
          break;
        case "Target.dispatchMessageFromTarget": {
          if (msg.params.targetId !== this.targetId) break;
          let inner: any;
          try {
            inner = JSON.parse(msg.params.message);
          } catch {
            break;
          }
          if (inner.id !== undefined) this.settle(inner);
          else this.onEvent(inner.method, inner.params);
          break;
        }
        default:
          this.onEvent(msg.method, msg.params);
      }
    });
    this.ws.on("close", () => this.markClosed("connection lost (page closed, app killed, or device disconnected)"));
    this.ws.on("error", () => {});
  }

  private onEvent(method: string, params: any) {
    if (method === "Console.messageAdded") this.addMessage(params.message);
    else if (method === "Console.messageRepeatCountUpdated") {
      // WebKit folds identical consecutive messages; record each repeat like Chromium does.
      const last = this.replay ? this.replay.at(-1)?.entry : this.console.all().at(-1);
      if (last) this.add({ ...last, time: (params.timestamp ?? Date.now() / 1000) * 1000 });
    }
  }

  private addMessage(m: ConsoleMessage) {
    const level = normalizeLevel(m.level);
    const isConsole = m.source === "console-api";
    const source = isConsole ? "console" : m.source === "javascript" && level === "error" ? "exception" : "browser";
    const text = isConsole && m.parameters?.length ? m.parameters.map(formatArg).join(" ") : m.text;
    this.add(
      {
        time: m.timestamp ? m.timestamp * 1000 : Date.now(),
        level,
        source,
        text: truncate(source === "browser" ? `[${m.source}] ${text}` : text),
        location: formatLocation(m),
      },
      isConsole ? m.parameters : undefined,
    );
  }

  private markClosed(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason ??= reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`Session closed: ${reason}`));
    }
    this.pending.clear();
  }

  async refreshTarget(): Promise<void> {
    if (this.closed) return;
    const info = await currentPageInfo(this.target);
    if (info) this.target = { ...this.target, ...info };
  }

  async evaluate(expression: string): Promise<{ text: string; isError: boolean }> {
    if (this.closed) throw new Error(`Session closed: ${this.closeReason}. Re-run list_targets and attach.`);
    const objectGroup = `${EVAL_GROUP}-${++this.evalCount}`;
    try {
      return await withEvalTimeout(this.evaluateInGroup(expression, objectGroup));
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }

  private async evaluateInGroup(expression: string, objectGroup: string): Promise<{ text: string; isError: boolean }> {
    let { result, wasThrown } = await this.send("Runtime.evaluate", {
      expression,
      objectGroup,
      generatePreview: true,
      emulateUserGesture: true,
    });
    // WebKit ignores awaitPromise on evaluate; it has a separate command for it.
    if (!wasThrown && result.type === "object" && result.className === "Promise" && result.objectId) {
      ({ result, wasThrown } = await this.send("Runtime.awaitPromise", {
        promiseObjectId: result.objectId,
        generatePreview: true,
      }));
    }
    if (wasThrown) return { text: truncate(formatArg(result), MAX_EVAL_TEXT), isError: true };
    return { text: await this.renderValue(result), isError: false };
  }

  /** Same rendering rules as the Chromium session: JSON for plain objects/arrays, description otherwise. */
  private async renderValue(o: RemoteObject): Promise<string> {
    if (o.type === "undefined") return "undefined";
    if (o.subtype === "node") return o.description ?? "node";
    if (o.objectId && o.type === "object" && (!o.subtype || o.subtype === "array")) {
      const { result, wasThrown } = await this.send("Runtime.callFunctionOn", {
        objectId: o.objectId,
        functionDeclaration: `function () {
          const s = JSON.stringify(this, null, 2);
          return typeof s === "string" && s.length > ${MAX_EVAL_TEXT} ? s.slice(0, ${MAX_EVAL_TEXT}) + "… [+" + (s.length - ${MAX_EVAL_TEXT}) + " chars]" : s;
        }`,
        returnByValue: true,
      });
      if (!wasThrown && typeof result.value === "string") return result.value;
    }
    return truncate(formatArg(o), MAX_EVAL_TEXT);
  }

  async close(reason = "detached") {
    if (this.closed) return;
    this.closeReason = reason;
    this.markClosed(reason);
    this.ws.close();
  }
}
