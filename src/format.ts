import type { RingBuffer } from "./ringBuffer.js";
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

export const MAX_TEXT = 1000;
export const BUFFER_SIZE = 1000;
export const MAX_EVAL_TEXT = 4000;
export const EVAL_TIMEOUT_MS = 10_000;

export function truncate(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

/** What the tools need from an attached page, whichever engine (Chromium CDP / WebKit) is behind it. */
export interface PageSession {
  target: Target;
  readonly console: RingBuffer<ConsoleEntry>;
  closed: boolean;
  closeReason?: string;
  refreshTarget(): Promise<void>;
  evaluate(expression: string): Promise<{ text: string; isError: boolean }>;
  close(reason?: string): Promise<void>;
}

/** Rejects after EVAL_TIMEOUT_MS so a page that never settles can't hang the tool call. */
export async function withEvalTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Evaluation did not finish within ${EVAL_TIMEOUT_MS / 1000}s (it may still be running in the page).`)),
      EVAL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
