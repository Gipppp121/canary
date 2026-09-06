/** One pass over everything you hold, plus any explicitly pinned token addresses. */

import type { Reader, Position } from "../chain/reader.js";
import type { Sink } from "../alert/sink.js";
import { Store } from "./store.js";
import { evaluate, type Alert, type Snapshot, type Thresholds, DEFAULT_THRESHOLDS } from "./signals.js";

export interface SweepResult {
  checked: number;
  alerts: Alert[];
  snapshots: Snapshot[];
}

export async function sweep(
  reader: Reader,
  store: Store,
  sink: Sink,
  wallets: string[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now(),
  tokens: string[] = []
): Promise<SweepResult> {
  const alerts: Alert[] = [];
  const snapshots: Snapshot[] = [];
  let checked = 0;
  const positions = new Map<string, Position>();

  for (const wallet of wallets) {
    const held = await reader.positions(wallet);
    for (const p of held) positions.set(p.token.toLowerCase(), p);
  }
  for (const token of tokens) {
    positions.set(token.toLowerCase(), { token, symbol: "TOKEN", balance: 0n });
  }

  for (const p of positions.values()) {
    let after;
    try {
      after = await reader.snapshot(p.token);
    } catch {
      continue; // an unreadable token is skipped, never guessed at
    }
    const before = store.get(p.token);
    const fired = evaluate(before, after, thresholds, now);
    for (const a of fired) {
      alerts.push(a);
      await sink.send(a);
    }
    store.put(after);
    snapshots.push(after);
    checked++;
  }

  store.save();
  return { checked, alerts, snapshots };
}
