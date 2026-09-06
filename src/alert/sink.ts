/** Where an alert goes. Terminal always, Telegram if configured. */

import type { Alert } from "../watch/signals.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  amber: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

export interface Sink {
  send(a: Alert): Promise<void> | void;
}

function tag(a: Alert): string {
  return a.level === "leave" ? "LEAVE" : a.level === "warn" ? "WATCH" : "INFO";
}

export class TerminalSink implements Sink {
  send(a: Alert): void {
    const colour = a.level === "leave" ? C.red : a.level === "warn" ? C.amber : C.cyan;
    console.log(`${colour}${C.bold}${tag(a).padEnd(5)}${C.reset}  ${a.headline}`);
    console.log(`       ${C.dim}${a.detail}${C.reset}`);
    if (a.was && a.now) console.log(`       ${C.dim}was ${a.was} · now ${a.now}${C.reset}`);
    console.log(`       ${C.dim}rule: ${a.rule}${C.reset}\n`);
  }
}

export class TelegramSink implements Sink {
  constructor(
    private token: string,
    private chatId: string,
    private fetchImpl: typeof fetch = fetch
  ) {}

  async send(a: Alert): Promise<void> {
    if (!this.token || !this.chatId) return;
    const text =
      `${tag(a)}  ${a.headline}\n${a.detail}` +
      (a.was && a.now ? `\nwas ${a.was} · now ${a.now}` : "") +
      `\nrule: ${a.rule}`;
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      });
      // Delivery is best-effort by design: the terminal watcher must stay alive.
      if (!res.ok) return;
    } catch {
      /* an alert that fails to deliver must never take the watcher down */
    }
  }
}

/** Same token + same rule only once inside the dedupe window. */
export class Deduped implements Sink {
  private seen = new Map<string, number>();
  constructor(private inner: Sink[], private windowMs = 30 * 60 * 1000) {}

  async send(a: Alert): Promise<void> {
    const key = `${a.token.toLowerCase()}:${a.rule}`;
    const last = this.seen.get(key) ?? 0;
    const now = Date.now();
    if (now - last < this.windowMs) return;
    this.seen.set(key, now);
    for (const s of this.inner) await s.send(a);
  }

  size(): number {
    return this.seen.size;
  }
}
