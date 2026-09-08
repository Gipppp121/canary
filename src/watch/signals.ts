/**
 * Canary v0.4 deterministic watch rules.
 *
 * No model, no score, no hidden state. Every alert is derived from one or two
 * snapshots so it can be tested offline and explained line by line.
 */

export type Level = "leave" | "warn" | "info";

export interface Snapshot {
  token: string;
  symbol: string;
  /** Pons deployer balance as a percent of current total supply. */
  devHoldPct: number;
  /** Real quote reserve while the launch is still on its Pons V2 curve. */
  liquidityWei: bigint;
  /** Number of recent curve trades or pool swaps found in the reader window. */
  trades: number;
  /** Unix milliseconds of the latest known trade. 0 means unknown. */
  lastTradeAt: number;
  /** Pending quote-denominated fees. */
  feesPendingWei: bigint;
  /** Recent launches by the same deployer in the indexed factory window. */
  deployerLaunches: number;
  /** Optional count when a reader can compute it cheaply. */
  deployerGraduated?: number;
  /** Pons V2 phase: 0 curve, 1 swept, 2 pool, 3 rescued. */
  phase?: number;
  curve?: string;
  deployer?: string;
  pairToken?: string;
  pairSymbol?: string;
  pairDecimals?: number;
  tokenDecimals?: number;
  poolId?: string;
  poolLiquidity?: bigint;
  poolTick?: number;
  poolPriceQuotePerToken?: number;
  poolPendingTokenFeesWei?: bigint;
  creatorTaxBps?: number;
  at: number;
}

export interface Thresholds {
  devSellPct: number;
  liquidityDropPct: number;
  volumeDeadMinutes: number;
  serialDeployerCount: number;
  /** Optional v0.4 graduated-pool thresholds. Defaults are used when omitted. */
  poolLiquidityDropPct?: number;
  poolPriceMovePct?: number;
  poolSwapBurstCount?: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  devSellPct: 2,
  liquidityDropPct: 15,
  volumeDeadMinutes: 30,
  serialDeployerCount: 12,
  poolLiquidityDropPct: 20,
  poolPriceMovePct: 25,
  poolSwapBurstCount: 20,
};

export interface Alert {
  rule: string;
  level: Level;
  token: string;
  symbol: string;
  headline: string;
  detail: string;
  was?: string;
  now?: string;
}

function threshold(t: Thresholds, key: "poolLiquidityDropPct" | "poolPriceMovePct" | "poolSwapBurstCount"): number {
  return t[key] ?? DEFAULT_THRESHOLDS[key] ?? 0;
}

/** A deployer balance drop is a balance movement, not proof of a sale. */
export function devSelling(a: Snapshot, b: Snapshot, t: Thresholds): Alert | null {
  const drop = a.devHoldPct - b.devHoldPct;
  if (drop <= t.devSellPct) return null;
  return {
    rule: "deployer-balance-drop",
    level: "leave",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: deployer balance fell ${drop.toFixed(1)} points`,
    detail: `deployer token balance changed from ${a.devHoldPct.toFixed(1)}% to ${b.devHoldPct.toFixed(1)}% of supply`,
    was: `${a.devHoldPct.toFixed(1)}%`,
    now: `${b.devHoldPct.toFixed(1)}%`,
  };
}

/** Sharp quote reserve loss while both snapshots are still on the curve. */
export function liquidityGone(a: Snapshot, b: Snapshot, t: Thresholds): Alert | null {
  if (a.phase !== undefined && b.phase !== undefined && (a.phase !== 0 || b.phase !== 0)) return null;
  if (a.liquidityWei <= 0n || b.liquidityWei >= a.liquidityWei) return null;
  const dropBps = ((a.liquidityWei - b.liquidityWei) * 10_000n) / a.liquidityWei;
  const dropPct = Number(dropBps) / 100;
  if (dropPct <= t.liquidityDropPct) return null;
  return {
    rule: "curve-reserve-drop",
    level: "leave",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: curve reserve fell ${dropPct.toFixed(1)}%`,
    detail: "real quote reserve shrank between sweeps while the launch was still on the bonding curve",
    was: a.liquidityWei.toString(),
    now: b.liquidityWei.toString(),
  };
}

/** v0.4: active Uniswap v4 liquidity fell materially after graduation. */
export function poolLiquidityGone(a: Snapshot, b: Snapshot, t: Thresholds): Alert | null {
  if (a.phase !== 2 || b.phase !== 2) return null;
  if (a.poolLiquidity === undefined || b.poolLiquidity === undefined) return null;
  if (a.poolLiquidity <= 0n || b.poolLiquidity >= a.poolLiquidity) return null;
  const dropBps = ((a.poolLiquidity - b.poolLiquidity) * 10_000n) / a.poolLiquidity;
  const dropPct = Number(dropBps) / 100;
  if (dropPct <= threshold(t, "poolLiquidityDropPct")) return null;
  return {
    rule: "pool-liquidity-drop",
    level: "leave",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: active pool liquidity fell ${dropPct.toFixed(1)}%`,
    detail: "Uniswap v4 active liquidity decreased materially between graduated-pool sweeps",
    was: a.poolLiquidity.toString(),
    now: b.poolLiquidity.toString(),
  };
}

/** Pending curve fees moved. This is not a creator-claim verdict. */
export function feesClaimed(a: Snapshot, b: Snapshot): Alert | null {
  if (a.phase !== undefined && b.phase !== undefined && (a.phase !== 0 || b.phase !== 0)) return null;
  if (b.feesPendingWei >= a.feesPendingWei) return null;
  const delta = a.feesPendingWei - b.feesPendingWei;
  return {
    rule: "fees-swept",
    level: "warn",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: pending curve fees moved`,
    detail: `${delta.toString()} wei left the curve fee balance between sweeps`,
    was: a.feesPendingWei.toString(),
    now: b.feesPendingWei.toString(),
  };
}

/** v0.4: launch-token hook fees moved after graduation. */
export function poolFeesMoved(a: Snapshot, b: Snapshot): Alert | null {
  if (a.phase !== 2 || b.phase !== 2) return null;
  if (a.poolPendingTokenFeesWei === undefined || b.poolPendingTokenFeesWei === undefined) return null;
  if (b.poolPendingTokenFeesWei >= a.poolPendingTokenFeesWei) return null;
  const delta = a.poolPendingTokenFeesWei - b.poolPendingTokenFeesWei;
  return {
    rule: "pool-token-fees-moved",
    level: "warn",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: pending pool token fees moved`,
    detail: `${delta.toString()} raw token units left the hook fee balance between sweeps`,
    was: a.poolPendingTokenFeesWei.toString(),
    now: b.poolPendingTokenFeesWei.toString(),
  };
}

/** v0.4: large pool price movement is volatility context, not a trade instruction. */
export function poolPriceMoved(a: Snapshot, b: Snapshot, t: Thresholds): Alert | null {
  if (a.phase !== 2 || b.phase !== 2) return null;
  const before = a.poolPriceQuotePerToken;
  const after = b.poolPriceQuotePerToken;
  if (before === undefined || after === undefined || before <= 0 || after <= 0) return null;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const movePct = ((after - before) / before) * 100;
  if (Math.abs(movePct) < threshold(t, "poolPriceMovePct")) return null;
  return {
    rule: "pool-price-move",
    level: "warn",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: pool price moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}%`,
    detail: "display price changed materially between graduated-pool sweeps; this is volatility context only",
    was: before.toString(),
    now: after.toString(),
  };
}

/** v0.4: a sudden increase in observed pool swaps. */
export function poolSwapBurst(a: Snapshot, b: Snapshot, t: Thresholds): Alert | null {
  if (a.phase !== 2 || b.phase !== 2) return null;
  const delta = b.trades - a.trades;
  if (delta < threshold(t, "poolSwapBurstCount")) return null;
  return {
    rule: "pool-swap-burst",
    level: "warn",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: ${delta} additional swaps entered the recent window`,
    detail: "observed pool activity increased sharply between sweeps",
    was: String(a.trades),
    now: String(b.trades),
  };
}

/** Unknown trade history stays quiet instead of inventing a timestamp. */
export function volumeDead(b: Snapshot, t: Thresholds, now: number = Date.now()): Alert | null {
  if (b.phase !== undefined && b.phase !== 0) return null;
  if (!b.lastTradeAt || b.lastTradeAt <= 0) return null;
  const deadFor = now - b.lastTradeAt;
  if (deadFor < t.volumeDeadMinutes * 60_000) return null;
  const minutes = Math.floor(deadFor / 60_000);
  return {
    rule: "volume-dead",
    level: "warn",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: no curve trade for ${minutes} minutes`,
    detail: `latest indexed CurveBuy/CurveSell is older than the ${t.volumeDeadMinutes}m threshold`,
  };
}

/** Same deployer has launched many tokens in the recent factory index window. */
export function serialDeployer(b: Snapshot, t: Thresholds): Alert | null {
  if (b.deployerLaunches < t.serialDeployerCount) return null;
  let detail = `${b.deployerLaunches} launches by the same deployer in the indexed window`;
  if (b.deployerGraduated !== undefined && b.deployerLaunches > 0) {
    detail += `; ${b.deployerGraduated} graduated (${((b.deployerGraduated / b.deployerLaunches) * 100).toFixed(1)}%)`;
  }
  return {
    rule: "serial-deployer",
    level: "warn",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: deployer has ${b.deployerLaunches} recent launches`,
    detail,
  };
}

/** A launch changing venue is context, not a danger verdict. */
export function phaseChanged(a: Snapshot, b: Snapshot): Alert | null {
  if (a.phase === undefined || b.phase === undefined || a.phase === b.phase) return null;
  const names = ["curve", "swept", "pool", "rescued"];
  return {
    rule: "phase-change",
    level: "info",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: phase changed ${names[a.phase] ?? a.phase} -> ${names[b.phase] ?? b.phase}`,
    detail: "Pons V2 routing state changed between sweeps",
  };
}

/** Run every deterministic rule over one position. Worst news first. */
export function evaluate(
  before: Snapshot | undefined,
  after: Snapshot,
  t: Thresholds = DEFAULT_THRESHOLDS,
  now: number = Date.now()
): Alert[] {
  const out: Alert[] = [];
  if (before) {
    const phase = phaseChanged(before, after);
    if (phase) out.push(phase);
    const dev = devSelling(before, after, t);
    if (dev) out.push(dev);
    const curveLiq = liquidityGone(before, after, t);
    if (curveLiq) out.push(curveLiq);
    const poolLiq = poolLiquidityGone(before, after, t);
    if (poolLiq) out.push(poolLiq);
    const curveFees = feesClaimed(before, after);
    if (curveFees) out.push(curveFees);
    const tokenFees = poolFeesMoved(before, after);
    if (tokenFees) out.push(tokenFees);
    const priceMove = poolPriceMoved(before, after, t);
    if (priceMove) out.push(priceMove);
    const burst = poolSwapBurst(before, after, t);
    if (burst) out.push(burst);
  }
  const dead = volumeDead(after, t, now);
  if (dead) out.push(dead);
  const serial = serialDeployer(after, t);
  if (serial) out.push(serial);

  const rank: Record<Level, number> = { leave: 0, warn: 1, info: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}
