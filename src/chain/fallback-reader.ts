/** Canary v0.4 resilient read-only reader wrapper. */

import type { Reader, Position } from "./reader.js";
import type { Snapshot } from "../watch/signals.js";

export function rpcUrlList(primary: string, rawFallbacks: string | undefined): string[] {
  const extra = (rawFallbacks ?? "")
    .split(/[;,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set([primary.trim(), ...extra].filter(Boolean))];
}

export class FallbackReader implements Reader {
  private preferred = 0;

  constructor(private readonly readers: Reader[]) {
    if (!readers.length) throw new Error("FallbackReader needs at least one reader");
  }

  private order(): number[] {
    const out: number[] = [];
    for (let n = 0; n < this.readers.length; n++) out.push((this.preferred + n) % this.readers.length);
    return out;
  }

  private async first<T>(name: string, call: (reader: Reader) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (const index of this.order()) {
      const reader = this.readers[index]!;
      try {
        const value = await call(reader);
        this.preferred = index;
        return value;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new Error(`${name} failed on ${this.readers.length} RPC reader(s): ${errors.join(" | ")}`);
  }

  positions(wallet: string): Promise<Position[]> {
    return this.first("positions", (reader) => reader.positions(wallet));
  }

  snapshot(token: string): Promise<Snapshot> {
    return this.first("snapshot", (reader) => reader.snapshot(token));
  }

  async health(): Promise<{ ok: boolean; chainId?: number; block?: bigint; error?: string }> {
    const errors: string[] = [];
    for (const index of this.order()) {
      const reader = this.readers[index]!;
      try {
        const health = await reader.health();
        if (health.ok) {
          this.preferred = index;
          return health;
        }
        errors.push(health.error ?? "health check failed");
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return { ok: false, error: errors.join(" | ") || "all RPC readers failed" };
  }
}
