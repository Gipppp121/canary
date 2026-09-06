/**
 * Live, read-only Pons V2 reader for Robinhood Chain.
 *
 * No wallet client is created here. No account is imported. Every transport is
 * a public client and every contract call is read-only.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
} from "viem";
import type { Reader, Position } from "./reader.js";
import type { Snapshot } from "../watch/signals.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ROBINHOOD_CHAIN_ID, DEFAULT_RPC_URL, DEFAULT_PONS_V2_FACTORY as FACTORY_DEFAULT } from "./config.js";

export { ROBINHOOD_CHAIN_ID, DEFAULT_RPC_URL } from "./config.js";
export const DEFAULT_PONS_V2_FACTORY = FACTORY_DEFAULT as Address;

const robinhood = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
} as const;

const launchEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
);

const factoryAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const curveAbi = parseAbi([
  "function realQuoteReserve() view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
]);

const tradeEvents = [
  parseAbiItem("event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)"),
  parseAbiItem("event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)"),
] as const;

interface LaunchIndexEntry {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchBlock: bigint;
}

export interface PonsV2ReaderOptions {
  rpcUrl: string;
  factory?: Address;
  indexLookbackBlocks?: number;
  tradeLookbackBlocks?: number;
  logChunkBlocks?: number;
  pinnedTokens?: Address[];
  discoveryMaxTokens?: number;
  indexCachePath?: string;
}

function asAddress(v: string): Address {
  return v as Address;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class PonsV2Reader implements Reader {
  private client: any;
  private factory: Address;
  private indexLookbackBlocks: bigint;
  private tradeLookbackBlocks: bigint;
  private logChunkBlocks: bigint;
  private pinnedTokens: Address[];
  private discoveryMaxTokens: number;
  private index = new Map<string, LaunchIndexEntry>();
  private indexedThrough = 0n;
  private indexBuiltAt = 0;
  private indexCachePath: string;

  constructor(opts: PonsV2ReaderOptions) {
    this.factory = opts.factory ?? DEFAULT_PONS_V2_FACTORY;
    this.indexLookbackBlocks = BigInt(opts.indexLookbackBlocks ?? 400_000);
    this.tradeLookbackBlocks = BigInt(opts.tradeLookbackBlocks ?? 20_000);
    this.logChunkBlocks = BigInt(opts.logChunkBlocks ?? 20_000);
    this.pinnedTokens = opts.pinnedTokens ?? [];
    this.discoveryMaxTokens = opts.discoveryMaxTokens ?? 250;
    this.indexCachePath = opts.indexCachePath ?? ".canary/launch-index.json";
    this.loadIndexCache();
    this.client = createPublicClient({ chain: robinhood, transport: http(opts.rpcUrl, { timeout: 12_000 }) });
  }

  private loadIndexCache(): void {
    if (!existsSync(this.indexCachePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.indexCachePath, "utf8")) as {
        version: number;
        factory: string;
        indexedThrough: string;
        entries: Array<Omit<LaunchIndexEntry, "launchBlock"> & { launchBlock: string }>;
      };
      if (raw.version !== 1 || raw.factory.toLowerCase() !== this.factory.toLowerCase()) return;
      this.indexedThrough = BigInt(raw.indexedThrough);
      for (const e of raw.entries) {
        this.index.set(e.token.toLowerCase(), { ...e, launchBlock: BigInt(e.launchBlock) });
      }
    } catch {
      // Corrupt cache means a fresh index, never a guessed one.
      this.index.clear();
      this.indexedThrough = 0n;
    }
  }

  private saveIndexCache(): void {
    try {
      mkdirSync(dirname(this.indexCachePath), { recursive: true });
      const entries = [...this.index.values()].map((e) => ({ ...e, launchBlock: e.launchBlock.toString() }));
      writeFileSync(this.indexCachePath, JSON.stringify({
        version: 1,
        factory: this.factory,
        indexedThrough: this.indexedThrough.toString(),
        entries,
      }, null, 2));
    } catch {
      // Cache failure must not take the watcher down.
    }
  }

  private async getLaunchLogs(fromBlock: bigint, toBlock: bigint) {
    const all: any[] = [];
    let from = fromBlock;
    while (from <= toBlock) {
      const to = from + this.logChunkBlocks - 1n > toBlock ? toBlock : from + this.logChunkBlocks - 1n;
      const logs = await this.client.getLogs({
        address: this.factory,
        event: launchEvent,
        fromBlock: from,
        toBlock: to,
      });
      all.push(...logs);
      from = to + 1n;
      if (from <= toBlock) await new Promise((r) => setTimeout(r, 100));
    }
    return all;
  }

  private async refreshIndex(force = false): Promise<void> {
    if (!force && Date.now() - this.indexBuiltAt < 5 * 60_000 && this.indexedThrough > 0n) return;
    const latest = await this.client.getBlockNumber();
    let from: bigint;
    if (this.indexedThrough > 0n) {
      from = this.indexedThrough + 1n;
    } else {
      from = latest > this.indexLookbackBlocks ? latest - this.indexLookbackBlocks : 0n;
    }
    if (from <= latest) {
      const logs = await this.getLaunchLogs(from, latest);
      for (const log of logs) {
        const token = log.args.token;
        const curve = log.args.curve;
        const deployer = log.args.deployer;
        const pairToken = log.args.pairToken;
        if (!token || !curve || !deployer || !pairToken || log.blockNumber === null) continue;
        this.index.set(token.toLowerCase(), {
          token,
          curve,
          deployer,
          pairToken,
          launchBlock: log.blockNumber,
        });
      }
    }
    const cutoff = latest > this.indexLookbackBlocks ? latest - this.indexLookbackBlocks : 0n;
    for (const [key, entry] of this.index) {
      if (entry.launchBlock > 0n && entry.launchBlock < cutoff) this.index.delete(key);
    }
    this.indexedThrough = latest;
    this.indexBuiltAt = Date.now();
    this.saveIndexCache();
  }

  private async launchFor(token: Address): Promise<LaunchIndexEntry> {
    await this.refreshIndex();
    const cached = this.index.get(token.toLowerCase());
    if (cached) return cached;

    const launch = await this.client.readContract({
      address: this.factory,
      abi: factoryAbi,
      functionName: "getLaunchedToken",
      args: [token],
    });
    if (!launch.exists) throw new Error(`${token} is not a launch from the configured Pons V2 factory`);
    return {
      token,
      curve: launch.curve,
      deployer: launch.deployer,
      pairToken: launch.pairToken,
      launchBlock: 0n,
    };
  }

  async positions(wallet: string): Promise<Position[]> {
    await this.refreshIndex();
    const candidates = new Map<string, Address>();
    const newest = [...this.index.values()]
      .sort((a, b) => (a.launchBlock > b.launchBlock ? -1 : a.launchBlock < b.launchBlock ? 1 : 0))
      .slice(0, this.discoveryMaxTokens);
    for (const e of newest) candidates.set(e.token.toLowerCase(), e.token);
    for (const token of this.pinnedTokens) candidates.set(token.toLowerCase(), token);

    const tokens = [...candidates.values()];
    const balances = await mapLimit<Address, Position | null>(tokens, 8, async (token) => {
      try {
        const balance = await this.client.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [asAddress(wallet)],
        });
        if (balance === 0n) return null;
        let symbol = "TOKEN";
        try {
          symbol = await this.client.readContract({ address: token, abi: tokenAbi, functionName: "symbol" });
        } catch {
          // A broken symbol() should not hide a real balance.
        }
        return { token, symbol, balance };
      } catch {
        return null;
      }
    });
    return balances.filter((v): v is Position => v !== null);
  }

  private async recentTrades(curve: Address, launchBlock: bigint): Promise<{ count: number; lastTradeAt: number }> {
    const latest = await this.client.getBlockNumber();
    const floor = latest > this.tradeLookbackBlocks ? latest - this.tradeLookbackBlocks : 0n;
    const from = launchBlock > floor ? launchBlock : floor;
    try {
      const logs = await this.client.getLogs({
        address: curve,
        events: tradeEvents,
        fromBlock: from,
        toBlock: latest,
      });
      if (!logs.length) return { count: 0, lastTradeAt: 0 };
      const last = logs[logs.length - 1]!;
      if (last.blockNumber === null) return { count: logs.length, lastTradeAt: 0 };
      const block = await this.client.getBlock({ blockNumber: last.blockNumber });
      return { count: logs.length, lastTradeAt: Number(block.timestamp) * 1000 };
    } catch {
      // Public RPCs can refuse broad log windows. Unknown stays unknown, not "dead".
      return { count: 0, lastTradeAt: 0 };
    }
  }

  async snapshot(tokenRaw: string): Promise<Snapshot> {
    const token = asAddress(tokenRaw);
    const indexed = await this.launchFor(token);
    const launch = await this.client.readContract({
      address: this.factory,
      abi: factoryAbi,
      functionName: "getLaunchedToken",
      args: [token],
    });
    if (!launch.exists) throw new Error(`${token} is not a Pons V2 launch in the configured factory`);

    const [symbol, totalSupply, devBalance] = await Promise.all([
      this.client.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }).catch(() => "TOKEN"),
      this.client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }),
      this.client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [launch.deployer] }),
    ]);

    let reserve = 0n;
    let feesPending = 0n;
    if (launch.phase === 0) {
      const vals = await Promise.allSettled([
        this.client.readContract({ address: launch.curve, abi: curveAbi, functionName: "realQuoteReserve" }),
        this.client.readContract({ address: launch.curve, abi: curveAbi, functionName: "quoteFeeBalance" }),
        this.client.readContract({ address: launch.curve, abi: curveAbi, functionName: "creatorTaxBalance" }),
      ]);
      reserve = vals[0].status === "fulfilled" ? vals[0].value : 0n;
      const q = vals[1].status === "fulfilled" ? vals[1].value : 0n;
      const tax = vals[2].status === "fulfilled" ? vals[2].value : 0n;
      feesPending = q + tax;
    }

    const trades = launch.phase === 0
      ? await this.recentTrades(launch.curve, indexed.launchBlock)
      : { count: 0, lastTradeAt: 0 };

    const zero = "0x0000000000000000000000000000000000000000";
    let pairSymbol = "ETH";
    let pairDecimals = 18;
    if (launch.pairToken.toLowerCase() !== zero) {
      const pairMeta = await Promise.allSettled([
        this.client.readContract({ address: launch.pairToken, abi: tokenAbi, functionName: "symbol" }),
        this.client.readContract({ address: launch.pairToken, abi: tokenAbi, functionName: "decimals" }),
      ]);
      if (pairMeta[0].status === "fulfilled") pairSymbol = pairMeta[0].value;
      if (pairMeta[1].status === "fulfilled") pairDecimals = Number(pairMeta[1].value);
    }

    await this.refreshIndex();
    let deployerLaunches = 0;
    for (const e of this.index.values()) {
      if (e.deployer.toLowerCase() === launch.deployer.toLowerCase()) deployerLaunches++;
    }

    const devHoldPct = totalSupply > 0n
      ? Number((devBalance * 1_000_000n) / totalSupply) / 10_000
      : 0;

    return {
      token,
      symbol,
      devHoldPct,
      liquidityWei: reserve,
      trades: trades.count,
      lastTradeAt: trades.lastTradeAt,
      feesPendingWei: feesPending,
      deployerLaunches,
      phase: Number(launch.phase),
      curve: launch.curve,
      deployer: launch.deployer,
      pairToken: launch.pairToken,
      pairSymbol,
      pairDecimals,
      creatorTaxBps: Number(launch.creatorTaxBps),
      at: Date.now(),
    };
  }

  async health(): Promise<{ ok: boolean; chainId?: number; block?: bigint; error?: string }> {
    try {
      const [chainId, block, code] = await Promise.all([
        this.client.getChainId(),
        this.client.getBlockNumber(),
        this.client.getBytecode({ address: this.factory }),
      ]);
      if (chainId !== ROBINHOOD_CHAIN_ID) {
        return { ok: false, chainId, block, error: `expected chain id ${ROBINHOOD_CHAIN_ID}` };
      }
      if (!code || code === "0x") {
        return { ok: false, chainId, block, error: `no contract code at configured Pons V2 factory ${this.factory}` };
      }
      return { ok: true, chainId, block };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
