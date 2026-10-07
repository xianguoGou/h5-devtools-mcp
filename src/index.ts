#!/usr/bin/env node
// NOTE: stdout carries the MCP protocol. Never use console.log here — use console.error for diagnostics.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONSOLE_LEVELS, SessionManager, type ConsoleEntry } from "./session.js";
import { findTarget, formatTargets, listTargets } from "./targets.js";

const sessions = new SessionManager();
const server = new McpServer({ name: "h5-devtools-mcp", version: "0.1.0" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatEntry(e: ConsoleEntry): string {
  const src = e.source === "console" ? "" : ` ${e.source}`;
  // Exception text usually already contains the stack, so don't repeat the location.
  const loc = e.location && !e.text.includes(e.location) ? `  (${e.location})` : "";
  return `#${e.seq} ${formatTime(e.time)} [${e.level}${src}] ${e.text}${loc}`;
}

server.registerTool(
  "list_targets",
  {
    title: "List WebView pages",
    description:
      "List debuggable H5 pages running inside Android WebViews (and Chrome) on connected devices. " +
      "Returns a target id for each page to pass to attach.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const { targets, warnings } = await listTargets();
      return ok(formatTargets(targets, warnings));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "attach",
  {
    title: "Attach to a page",
    description:
      "Connect to a WebView page and start buffering its console output and uncaught exceptions. " +
      "Recent messages the engine still holds are replayed on attach, but attach before reproducing an issue to be sure nothing is missed.",
    inputSchema: {
      target_id: z.string().describe("Target id from list_targets"),
    },
  },
  async ({ target_id }) => {
    try {
      const target = await findTarget(target_id);
      const { session, reused } = await sessions.attach(target);
      const t = session.target;
      return ok(
        `${reused ? "Already attached" : "Attached"} to ${JSON.stringify(t.title)} (${t.url}) in ${t.app ?? "unknown app"}.\n` +
          `Buffered console entries so far: ${session.console.all().length}. Use get_console to read them.`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_console",
  {
    title: "Read console output",
    description:
      "Read buffered console messages, uncaught exceptions and browser log entries from an attached page. " +
      "Returns the most recent matching entries. Pass since_seq from a previous call to get only new entries.",
    inputSchema: {
      target_id: z.string().optional().describe("Defaults to the most recently attached page"),
      levels: z.array(z.enum(CONSOLE_LEVELS)).optional().describe("Only these levels, e.g. [\"warn\", \"error\"]"),
      keyword: z.string().optional().describe("Case-insensitive substring match on message text and location"),
      exclude_keywords: z
        .array(z.string().min(1))
        .optional()
        .describe("Drop entries whose text or location contains any of these (case-insensitive), e.g. [\"google-analytics\", \"doubleclick\"]"),
      since_seq: z.number().int().optional().describe("Only entries with seq greater than this"),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries to return (default 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ target_id, levels, keyword, exclude_keywords, since_seq, limit = 50 }) => {
    try {
      const session = sessions.get(target_id);
      const kw = keyword?.toLowerCase();
      const excludes = exclude_keywords?.map((k) => k.toLowerCase()) ?? [];
      const all = session.console.all();
      const matched = all.filter((e) => {
        const haystack = `${e.text}\n${e.location ?? ""}`.toLowerCase();
        return (
          (since_seq === undefined || e.seq > since_seq) &&
          (!levels || levels.includes(e.level)) &&
          (!kw || haystack.includes(kw)) &&
          !excludes.some((x) => haystack.includes(x))
        );
      });
      const shown = matched.slice(-limit);

      const header = [
        `Page: ${JSON.stringify(session.target.title)} (${session.target.url})`,
        `Showing ${shown.length} of ${matched.length} matching entries (buffer holds ${all.length}` +
          (session.console.dropped ? `, ${session.console.dropped} older entries dropped` : "") +
          ").",
      ];
      if (session.closed) header.push(`Session closed: ${session.closeReason}. Re-run list_targets and attach.`);

      const body = shown.length ? shown.map(formatEntry) : ["(no entries)"];
      const footer = `next since_seq: ${session.console.lastSeq}`;
      return ok([...header, "", ...body, "", footer].join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "evaluate_js",
  {
    title: "Evaluate JavaScript in a page",
    description:
      "Run a JavaScript expression in an attached page and return its result. Plain objects/arrays come back as JSON " +
      "(so nested Map/Set/DOM values show as {}); other values (DOM nodes, Map, Set, Error, window) as a short description. " +
      "Promises are awaited. For multiple statements or await, wrap them: (async () => { ... })(). " +
      "Runs with the page's full privileges, so it can read cookies/storage and change page state.",
    inputSchema: {
      expression: z.string().min(1).describe("JavaScript expression to evaluate"),
      target_id: z.string().optional().describe("Defaults to the most recently attached page"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ expression, target_id }) => {
    try {
      const { text, isError } = await sessions.get(target_id).evaluate(expression);
      return isError ? fail(new Error(`Uncaught ${text}`)) : ok(text);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "detach",
  {
    title: "Detach from a page",
    description: "Disconnect from a page and discard its buffered events.",
    inputSchema: {
      target_id: z.string().optional().describe("Defaults to the most recently attached page"),
    },
  },
  async ({ target_id }) => {
    try {
      const session = await sessions.detach(target_id);
      return ok(`Detached from ${JSON.stringify(session.target.title)}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

async function shutdown() {
  await sessions.closeAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error("h5-devtools-mcp running on stdio");
