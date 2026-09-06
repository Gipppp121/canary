/**
 * The only place that talks to a chain.
 *
 * It is an interface on purpose. Everything above it works on plain snapshots,
 * so the rules can be tested without a network and you can point this at your
 * own RPC, a fixture file, or nothing at all.
 */

import type { Snapshot } from "../watch/signals.js";

export interface Position {
  token: string;
  symbol: string;
  balance: bigint;
}

export interface Reader {
  /** every token this wallet still holds */
  positions(wallet: string): Promise<Position[]>;
  /** everything the rules need about one token, right now */
  snapshot(token: string): Promise<Snapshot>;
  /** chain id, block height, and whether the endpoint answers at all */
  health(): Promise<{ ok: boolean; chainId?: number; block?: bigint; error?: string }>;
}

/** A reader that returns fixtures. Used by `canary demo` and by the tests. */
export class FixtureReader implements Reader {
  constructor(
    private fixtures: Record<string, Snapshot>,
    private held: Record<string, Position[]> = {}
  ) {}

  async positions(wallet: string): Promise<Position[]> {
    return this.held[wallet.toLowerCase()] ?? [];
  }

  async snapshot(token: string): Promise<Snapshot> {
    const s = this.fixtures[token.toLowerCase()];
    if (!s) throw new Error(`no fixture for ${token}`);
    return { ...s, at: Date.now() };
  }

  async health() {
    return { ok: true, chainId: 4663, block: 53_396_287n };
  }

  /** move a fixture forward, the way a bad night moves a position */
  advance(token: string, patch: Partial<Snapshot>): void {
    const k = token.toLowerCase();
    const cur = this.fixtures[k];
    if (!cur) throw new Error(`no fixture for ${token}`);
    this.fixtures[k] = { ...cur, ...patch, at: Date.now() };
  }
}
