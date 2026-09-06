/**
 * Deterministic watch rules.
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
  /** Number of recent curve trades found in the reader's trade window. */
  trades: number;
  /** Unix milliseconds of the latest known curve trade. 0 means unknown. */
  lastTradeAt: number;
  /** Pending quote-denominated fees still sitting on the curve. */
  feesPendingWei: bigint;
  /** Recent launches by the same deployer in the indexed factory window. */
  deployerLaunches: number;
  /** Optional count when a reader can compute it cheaply. */
  deployerGraduated?: number;
  /** Pons V2 phase: 0 curve, 1 swept, 2 pool, 3 rescued. */
  phase?: number;
  /** Optional metadata surfaced by the live reader. */
  curve?: string;
  deployer?: string;
  pairToken?: string;
  pairSymbol?: string;
  pairDecimals?: number;
  tokenDecimals?: number;
  /** Uniswap v4 state, present after phase=2 graduation when readable. */
  poolId?: string;
  poolLiquidity?: bigint;
  poolTick?: number;
  poolPriceQuotePerToken?: number;
  /** Pending hook fees denominated in the launch token, separate from quote-side feesPendingWei. */
  poolPendingTokenFeesWei?: bigint;
  creatorTaxBps?: number;
  at: number;
}

export interface Thresholds {
  devSellPct: number;
  liquidityDropPct: number;
  volumeDeadMinutes: number;
  serialDeployerCount: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  devSellPct: 2,
  liquidityDropPct: 15,
  volumeDeadMinutes: 30,
  serialDeployerCount: 12,
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

/**
 * The deployer's token balance fell. This is intentionally not called a
 * "sell": an on-chain balance drop can also be a transfer or burn.
 */
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

/**
 * While phase=0, realQuoteReserve is the actual quote asset held by the curve.
 * A sharp drop means quote value left the curve between sweeps. We deliberately
 * do not compare across graduation because the reserve is expected to move.
 */
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
    detail: `real quote reserve shrank between sweeps while the launch was still on the bonding curve`,
  };
}

/** Pending curve fees fell. That means the curve was swept; it does not prove a creator claimed them. */
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
  };
}

/** No recent curve trade. Unknown last-trade data stays quiet instead of inventing a timestamp. */
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

/** A launch changing venue is useful context, but not a danger verdict. */
export function phaseChanged(a: Snapshot, b: Snapshot): Alert | null {
  if (a.phase === undefined || b.phase === undefined || a.phase === b.phase) return null;
  const names = ["curve", "swept", "pool", "rescued"];
  return {
    rule: "phase-change",
    level: "info",
    token: b.token,
    symbol: b.symbol,
    headline: `${b.symbol}: phase changed ${names[a.phase] ?? a.phase} → ${names[b.phase] ?? b.phase}`,
    detail: `Pons V2 routing state changed between sweeps`,
  };
}

/** Run every rule over one position. Worst news first. */
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
    const liq = liquidityGone(before, after, t);
    if (liq) out.push(liq);
    const fees = feesClaimed(before, after);
    if (fees) out.push(fees);
  }
  const dead = volumeDead(after, t, now);
  if (dead) out.push(dead);
  const serial = serialDeployer(after, t);
  if (serial) out.push(serial);

  const rank: Record<Level, number> = { leave: 0, warn: 1, info: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}
