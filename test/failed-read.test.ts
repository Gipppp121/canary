import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PonsV2Reader } from "../src/chain/rpc.js";
import { Store } from "../src/watch/store.js";
import { sweep } from "../src/watch/sweep.js";
import type { Sink } from "../src/alert/sink.js";
import type { Alert } from "../src/watch/signals.js";

const TOKEN = "0x00000000000000000000000000000000000000aa";
const CURVE = "0x00000000000000000000000000000000000000cc";
const DEPLOYER = "0x00000000000000000000000000000000000000dd";
const ZERO = "0x0000000000000000000000000000000000000000";

/** A minimal stand-in for the viem public client. `failing` names reads that reject, like a rate-limited RPC. */
function stubClient(phase: number, failing: Set<string>) {
  const values: Record<string, unknown> = {
    symbol: "TEST", totalSupply: 1_000n, balanceOf: 10n, decimals: 18,
    realQuoteReserve: 4_000_000_000_000_000_000n, quoteFeeBalance: 300n, creatorTaxBalance: 200n,
    getSlot0: [79228162514264337593543950336n, 0, 0, 0], getLiquidity: 5_000n,
    pendingFees: 70n, pendingCreatorTax: 30n,
  };
  return {
    getBlockNumber: async () => 1_000n,
    getLogs: async () => [],
    getBlock: async () => ({ timestamp: 1n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getLaunchedToken") {
        return { exists: true, curve: CURVE, deployer: DEPLOYER, pairToken: ZERO, phase, poolFee: 0, tickSpacing: 60, creatorTaxBps: 0 };
      }
      if (failing.has(functionName)) throw new Error(`HTTP request failed. Status: 429 (${functionName})`);
      return values[functionName];
    },
  };
}

function reader(client: unknown) {
  const r = new PonsV2Reader({ rpcUrl: "http://127.0.0.1:1", indexCachePath: join(mkdtempSync(join(tmpdir(), "canary-")), "index.json") });
  (r as unknown as { client: unknown }).client = client;
  return r;
}

class Collector implements Sink {
  got: Alert[] = [];
  send(a: Alert) { this.got.push(a); }
}

test("a failed curve reserve read is not reported as the reserve falling to zero", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "canary-")));
  const sink = new Collector();
  await sweep(reader(stubClient(0, new Set())), store, sink, [], undefined, Date.now(), [TOKEN]);
  await sweep(reader(stubClient(0, new Set(["realQuoteReserve"]))), store, sink, [], undefined, Date.now(), [TOKEN]);
  assert.deepEqual(sink.got.map((a) => a.rule), []);
  assert.equal(store.get(TOKEN)?.liquidityWei, 4_000_000_000_000_000_000n);
});

test("a failed curve fee read is not reported as fees leaving the curve", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "canary-")));
  const sink = new Collector();
  await sweep(reader(stubClient(0, new Set())), store, sink, [], undefined, Date.now(), [TOKEN]);
  await sweep(reader(stubClient(0, new Set(["creatorTaxBalance"]))), store, sink, [], undefined, Date.now(), [TOKEN]);
  assert.deepEqual(sink.got.map((a) => a.rule), []);
});

test("a failed pool hook fee read leaves pool token fees unknown", async () => {
  const snap = await reader(stubClient(2, new Set(["pendingCreatorTax"]))).snapshot(TOKEN);
  assert.equal(snap.poolPendingTokenFeesWei, undefined);
  const ok = await reader(stubClient(2, new Set())).snapshot(TOKEN);
  assert.equal(ok.poolPendingTokenFeesWei, 100n);
});
