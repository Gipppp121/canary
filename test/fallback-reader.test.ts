import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackReader, rpcUrlList } from "../src/chain/fallback-reader.js";
import type { Reader, Position } from "../src/chain/reader.js";
import type { Snapshot } from "../src/watch/signals.js";

const snap: Snapshot = {
  token: "0x0000000000000000000000000000000000000001",
  symbol: "OK",
  devHoldPct: 0,
  liquidityWei: 1n,
  trades: 1,
  lastTradeAt: Date.now(),
  feesPendingWei: 0n,
  deployerLaunches: 1,
  at: Date.now(),
};

class FakeReader implements Reader {
  constructor(private fail: boolean, private label: string) {}
  async positions(_wallet: string): Promise<Position[]> {
    if (this.fail) throw new Error(`${this.label} positions down`);
    return [{ token: snap.token, symbol: snap.symbol, balance: 1n }];
  }
  async snapshot(_token: string): Promise<Snapshot> {
    if (this.fail) throw new Error(`${this.label} snapshot down`);
    return snap;
  }
  async health() {
    return this.fail ? { ok: false, error: `${this.label} health down` } : { ok: true, chainId: 4663, block: 123n };
  }
}

test("rpcUrlList deduplicates primary and fallback urls", () => {
  assert.deepEqual(rpcUrlList("https://a", "https://b, https://a;https://c"), ["https://a", "https://b", "https://c"]);
});

test("FallbackReader moves to the next reader after an RPC failure", async () => {
  const reader = new FallbackReader([new FakeReader(true, "one"), new FakeReader(false, "two")]);
  const got = await reader.snapshot(snap.token);
  assert.equal(got.symbol, "OK");
  const health = await reader.health();
  assert.equal(health.ok, true);
});
