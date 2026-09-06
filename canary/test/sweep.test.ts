import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureReader } from "../src/chain/reader.js";
import { Store } from "../src/watch/store.js";
import { sweep } from "../src/watch/sweep.js";
import { Deduped, type Sink } from "../src/alert/sink.js";
import type { Alert, Snapshot } from "../src/watch/signals.js";

class Collector implements Sink {
  got: Alert[] = [];
  send(a: Alert) { this.got.push(a); }
}

const now = Date.now();
const base: Snapshot = {
  token: "0xbbb2", symbol: "NIGHTS", devHoldPct: 18,
  liquidityWei: 4_000_000_000_000_000_000n, trades: 30, lastTradeAt: now,
  feesPendingWei: 500n, deployerLaunches: 2, deployerGraduated: 1, at: now,
};

function fixtures() {
  return new FixtureReader(
    { "0xbbb2": { ...base } },
    { "0xw": [{ token: "0xbbb2", symbol: "NIGHTS", balance: 1n }] }
  );
}
function store() {
  return new Store(mkdtempSync(join(tmpdir(), "canary-")));
}

test("the first sweep only records, it does not shout", async () => {
  const sink = new Collector();
  const res = await sweep(fixtures(), store(), sink, ["0xw"]);
  assert.equal(res.checked, 1);
  assert.ok(sink.got.every((a) => a.rule !== "deployer-balance-drop"));
});

test("the second sweep catches a deployer balance drop", async () => {
  const reader = fixtures();
  const st = store();
  const sink = new Collector();
  await sweep(reader, st, sink, ["0xw"]);
  reader.advance("0xbbb2", { devHoldPct: 6 });
  await sweep(reader, st, sink, ["0xw"]);
  assert.ok(sink.got.some((a) => a.rule === "deployer-balance-drop" && a.level === "leave"));
});

test("an unreadable token is skipped, never guessed at", async () => {
  const reader = new FixtureReader({}, { "0xw": [{ token: "0xmissing", symbol: "?", balance: 1n }] });
  const res = await sweep(reader, store(), new Collector(), ["0xw"]);
  assert.equal(res.checked, 0);
  assert.equal(res.alerts.length, 0);
});

test("the same warning is not repeated inside the window", async () => {
  const inner = new Collector();
  const dedup = new Deduped([inner], 60_000);
  const reader = fixtures();
  const st = store();
  await sweep(reader, st, dedup, ["0xw"]);
  reader.advance("0xbbb2", { devHoldPct: 6 });
  await sweep(reader, st, dedup, ["0xw"]);
  reader.advance("0xbbb2", { devHoldPct: 2 });
  await sweep(reader, st, dedup, ["0xw"]);
  assert.equal(inner.got.filter((a) => a.rule === "deployer-balance-drop").length, 1);
});

test("snapshots survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-"));
  const reader = fixtures();
  await sweep(reader, new Store(dir), new Collector(), ["0xw"]);
  const reopened = new Store(dir);
  const kept = reopened.get("0xbbb2");
  assert.ok(kept);
  assert.equal(kept!.symbol, "NIGHTS");
  assert.equal(typeof kept!.liquidityWei, "bigint");
});
