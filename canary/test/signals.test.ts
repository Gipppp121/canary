import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate, devSelling, liquidityGone, feesClaimed, volumeDead, serialDeployer,
  DEFAULT_THRESHOLDS, type Snapshot,
} from "../src/watch/signals.js";

const now = Date.now();
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  token: "0xtok", symbol: "TEST", devHoldPct: 4,
  liquidityWei: 4_000_000_000_000_000_000n, trades: 20, lastTradeAt: now,
  feesPendingWei: 100_000_000_000_000_000n, deployerLaunches: 2,
  deployerGraduated: 1, at: now, ...over,
});

test("a quiet position wakes nobody", () => {
  assert.equal(evaluate(snap(), snap(), DEFAULT_THRESHOLDS, now).length, 0);
});

test("a deployer balance drop is a high-severity signal", () => {
  const a = devSelling(snap({ devHoldPct: 18 }), snap({ devHoldPct: 9 }), DEFAULT_THRESHOLDS);
  assert.ok(a);
  assert.equal(a!.level, "leave");
  assert.equal(a!.rule, "deployer-balance-drop");
  assert.equal(a!.was, "18.0%");
  assert.equal(a!.now, "9.0%");
});

test("a deployer buying more is not an alert", () => {
  assert.equal(devSelling(snap({ devHoldPct: 4 }), snap({ devHoldPct: 7 }), DEFAULT_THRESHOLDS), null);
});

test("a move under the threshold stays quiet", () => {
  assert.equal(devSelling(snap({ devHoldPct: 4 }), snap({ devHoldPct: 3 }), DEFAULT_THRESHOLDS), null);
});

test("liquidity leaving fires as leave", () => {
  const a = liquidityGone(
    snap({ liquidityWei: 4_000_000_000_000_000_000n }),
    snap({ liquidityWei: 2_000_000_000_000_000_000n }),
    DEFAULT_THRESHOLDS
  );
  assert.ok(a);
  assert.equal(a!.level, "leave");
  assert.match(a!.headline, /50\.0%/);
});

test("liquidity growing is not a drop", () => {
  assert.equal(
    liquidityGone(snap({ liquidityWei: 1n }), snap({ liquidityWei: 9n }), DEFAULT_THRESHOLDS),
    null
  );
});

test("a curve fee sweep is a warning, not a creator-claim verdict", () => {
  const a = feesClaimed(snap({ feesPendingWei: 500n }), snap({ feesPendingWei: 0n }));
  assert.ok(a);
  assert.equal(a!.level, "warn");
});

test("fees accruing is not a claim", () => {
  assert.equal(feesClaimed(snap({ feesPendingWei: 100n }), snap({ feesPendingWei: 400n })), null);
});

test("a book nobody trades in gets flagged", () => {
  const a = volumeDead(snap({ lastTradeAt: now - 45 * 60_000 }), DEFAULT_THRESHOLDS, now);
  assert.ok(a);
  assert.match(a!.headline, /45 minutes/);
});

test("a serial deployer is named with its own graduation rate", () => {
  const a = serialDeployer(snap({ deployerLaunches: 297, deployerGraduated: 0 }), DEFAULT_THRESHOLDS);
  assert.ok(a);
  assert.match(a!.detail, /297 launches/);
  assert.match(a!.detail, /0 graduated/);
  assert.match(a!.detail, /0\.0%/);
});

test("one launch by a first-time deployer is not suspicious", () => {
  assert.equal(serialDeployer(snap({ deployerLaunches: 1 }), DEFAULT_THRESHOLDS), null);
});

test("the worst news is printed first", () => {
  const before = snap({ devHoldPct: 20, feesPendingWei: 900n, lastTradeAt: now - 90 * 60_000 });
  const after = snap({ devHoldPct: 5, feesPendingWei: 0n, lastTradeAt: now - 90 * 60_000,
                       deployerLaunches: 40, deployerGraduated: 1 });
  const out = evaluate(before, after, DEFAULT_THRESHOLDS, now);
  assert.equal(out[0]!.level, "leave");
  assert.ok(out.length >= 3);
});



test("unknown trade history never becomes a fake volume-dead alert", () => {
  const a = volumeDead(snap({ lastTradeAt: 0 }), DEFAULT_THRESHOLDS, now);
  assert.equal(a, null);
});

test("graduation does not look like a curve reserve collapse", () => {
  const a = liquidityGone(
    snap({ phase: 0, liquidityWei: 4_000_000_000_000_000_000n }),
    snap({ phase: 2, liquidityWei: 0n }),
    DEFAULT_THRESHOLDS
  );
  assert.equal(a, null);
});

test("the first sweep of a new token cannot compare, and says nothing about change", () => {
  const out = evaluate(undefined, snap(), DEFAULT_THRESHOLDS, now);
  assert.ok(out.every((a) => a.rule !== "deployer-balance-drop"));
});
