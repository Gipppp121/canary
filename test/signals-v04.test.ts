import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  poolLiquidityGone,
  poolPriceMoved,
  poolFeesMoved,
  poolSwapBurst,
  evaluate,
  type Snapshot,
} from "../src/watch/signals.js";

const now = Date.now();
const pool = (over: Partial<Snapshot> = {}): Snapshot => ({
  token: "0x0000000000000000000000000000000000000001",
  symbol: "POOLX",
  devHoldPct: 2,
  liquidityWei: 0n,
  trades: 100,
  lastTradeAt: now,
  feesPendingWei: 10n,
  deployerLaunches: 1,
  phase: 2,
  poolLiquidity: 1_000_000n,
  poolPriceQuotePerToken: 0.000001,
  poolPendingTokenFeesWei: 500n,
  at: now,
  ...over,
});

test("v0.4 flags a material graduated-pool liquidity drop", () => {
  const a = poolLiquidityGone(pool({ poolLiquidity: 1_000_000n }), pool({ poolLiquidity: 700_000n }), DEFAULT_THRESHOLDS);
  assert.ok(a);
  assert.equal(a!.rule, "pool-liquidity-drop");
  assert.equal(a!.level, "leave");
});

test("v0.4 keeps a small graduated-pool liquidity move quiet", () => {
  assert.equal(poolLiquidityGone(pool({ poolLiquidity: 1_000_000n }), pool({ poolLiquidity: 900_000n }), DEFAULT_THRESHOLDS), null);
});

test("v0.4 reports large pool price movement as WATCH context", () => {
  const a = poolPriceMoved(pool({ poolPriceQuotePerToken: 1 }), pool({ poolPriceQuotePerToken: 1.4 }), DEFAULT_THRESHOLDS);
  assert.ok(a);
  assert.equal(a!.rule, "pool-price-move");
  assert.equal(a!.level, "warn");
});

test("v0.4 notices pending pool token fees moving", () => {
  const a = poolFeesMoved(pool({ poolPendingTokenFeesWei: 500n }), pool({ poolPendingTokenFeesWei: 100n }));
  assert.ok(a);
  assert.equal(a!.rule, "pool-token-fees-moved");
});

test("v0.4 notices a sudden pool swap burst", () => {
  const a = poolSwapBurst(pool({ trades: 100 }), pool({ trades: 125 }), DEFAULT_THRESHOLDS);
  assert.ok(a);
  assert.equal(a!.rule, "pool-swap-burst");
});

test("v0.4 evaluate keeps worst pool news first", () => {
  const before = pool({ poolLiquidity: 1_000_000n, poolPriceQuotePerToken: 1, trades: 100 });
  const after = pool({ poolLiquidity: 500_000n, poolPriceQuotePerToken: 1.5, trades: 130 });
  const out = evaluate(before, after, DEFAULT_THRESHOLDS, now);
  assert.equal(out[0]!.level, "leave");
  assert.ok(out.some((a) => a.rule === "pool-price-move"));
  assert.ok(out.some((a) => a.rule === "pool-swap-burst"));
});
