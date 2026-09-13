#!/usr/bin/env node
/** Canary v0.4 local control plane and persistent read-only web desk. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { PonsV2Reader } from "../chain/rpc.js";
import type { Reader } from "../chain/reader.js";
import { FallbackReader, rpcUrlList } from "../chain/fallback-reader.js";
import { controlAuthorized } from "./control-auth.js";
import { Store } from "../watch/store.js";
import { evaluate, type Alert, type Snapshot } from "../watch/signals.js";
import { isAddress, loadConfig, loadLocalEnv } from "../util/env.js";
import { units } from "../util/fmt.js";

loadLocalEnv();
const CONFIG = loadConfig();

const ROOT = process.cwd();
const STORE_FILE = join(ROOT, ".canary", "snapshots.json");
const MEMORY_FILE = join(ROOT, ".canary", "board-memory.json");
const WATCHLIST_FILE = join(ROOT, ".canary", "watchlist.json");
const PHASE = ["CURVE", "SWEPT", "POOL", "RESCUED"];
const SAMPLE_LIMIT = 720;
const ALERT_LIMIT = 2000;
const WATCH_INTERVAL_MS = 10_000;
const CREATOR_X = process.env.CANARY_CREATOR_X?.trim() || "gippp69";

interface StoreFile {
  version: number;
  updatedAt: number;
  positions: Record<string, Snapshot>;
}

interface RememberedAlert extends Alert {
  at: number;
}

interface MemoryFile {
  version: 1;
  updatedAt: number;
  samples: Record<string, Snapshot[]>;
  alerts: RememberedAlert[];
}

interface WatchlistFile {
  version: 1;
  tokens: string[];
}

type WatcherStatus = "starting" | "running" | "retrying";

interface SweepEvent {
  at: number;
  sweep: number;
  durationMs: number;
  status: "QUIET" | "WATCH" | "LEAVE" | "INFO" | "ERROR";
  changes: string[];
  message: string;
}

interface WatcherRuntime {
  token: string;
  startedAt: number;
  status: WatcherStatus;
  reader: Reader;
  timer?: ReturnType<typeof setTimeout>;
  lastSweepAt: number;
  nextSweepAt: number;
  lastDurationMs: number;
  lastError: string;
  consecutiveErrors: number;
  sweepCount: number;
  events: SweepEvent[];
}

interface RpcHealth {
  status: "probing" | "ok" | "error";
  checkedAt: number;
  chainId?: number;
  block?: string;
  error?: string;
}

const watchers = new Map<string, WatcherRuntime>();
let rpcHealth: RpcHealth = { status: "probing", checkedAt: 0 };
let writeQueue: Promise<void> = Promise.resolve();

function replacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v.toString()}n` : v;
}

function reviver(_k: string, v: unknown): unknown {
  return typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"), reviver) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, replacer, 2));
}

function storeState(): StoreFile {
  return readJson<StoreFile>(STORE_FILE, { version: 1, updatedAt: 0, positions: {} });
}

function memoryState(): MemoryFile {
  return readJson<MemoryFile>(MEMORY_FILE, { version: 1, updatedAt: 0, samples: {}, alerts: [] });
}

function writeMemory(memory: MemoryFile): void {
  writeJson(MEMORY_FILE, memory);
}

function readWatchlist(): string[] {
  const raw = readJson<WatchlistFile>(WATCHLIST_FILE, { version: 1, tokens: [] });
  return [...new Set(raw.tokens.map((x) => x.trim()).filter(isAddress).map((x) => x.toLowerCase()))];
}

function writeWatchlist(): void {
  const tokens = [...watchers.values()].map((w) => w.token.toLowerCase()).sort();
  writeJson(WATCHLIST_FILE, { version: 1, tokens } satisfies WatchlistFile);
}

function sanitizeLocalState(): void {
  const store = storeState();
  let storeChanged = false;
  for (const [key, snapshot] of Object.entries(store.positions)) {
    if (!isAddress(snapshot.token)) {
      delete store.positions[key];
      storeChanged = true;
    }
  }
  if (storeChanged) {
    store.updatedAt = Date.now();
    writeJson(STORE_FILE, store);
  }

  const memory = memoryState();
  let memoryChanged = false;
  for (const key of Object.keys(memory.samples)) {
    const samples = memory.samples[key] ?? [];
    const valid = samples.filter((s) => isAddress(s.token));
    if (valid.length !== samples.length || !isAddress(key)) {
      delete memory.samples[key];
      memoryChanged = true;
    }
  }
  const alerts = memory.alerts.filter((a) => isAddress(a.token));
  if (alerts.length !== memory.alerts.length) {
    memory.alerts = alerts;
    memoryChanged = true;
  }
  if (memoryChanged) {
    memory.updatedAt = Date.now();
    writeMemory(memory);
  }
}

function sampleMemory(): MemoryFile {
  const store = storeState();
  const memory = memoryState();
  let changed = false;

  for (const snapshot of Object.values(store.positions)) {
    if (!isAddress(snapshot.token)) continue;
    const key = snapshot.token.toLowerCase();
    const samples = memory.samples[key] ?? [];
    const previous = samples.at(-1);
    if (previous?.at === snapshot.at) continue;

    const alerts = evaluate(previous, snapshot, {
      devSellPct: CONFIG.devSellPct,
      liquidityDropPct: CONFIG.liquidityDropPct,
      volumeDeadMinutes: CONFIG.volumeDeadMinutes,
      serialDeployerCount: CONFIG.serialDeployerCount,
      poolLiquidityDropPct: CONFIG.poolLiquidityDropPct,
      poolPriceMovePct: CONFIG.poolPriceMovePct,
      poolSwapBurstCount: CONFIG.poolSwapBurstCount,
    }, snapshot.at || Date.now());

    for (const alert of alerts) {
      const at = snapshot.at || Date.now();
      const duplicate = memory.alerts.some((x) =>
        x.token.toLowerCase() === alert.token.toLowerCase() &&
        x.rule === alert.rule &&
        Math.abs(x.at - at) < 1_000
      );
      if (!duplicate) memory.alerts.push({ ...alert, at });
    }

    samples.push(snapshot);
    memory.samples[key] = samples.slice(-SAMPLE_LIMIT);
    changed = true;
  }

  if (memory.alerts.length > ALERT_LIMIT) memory.alerts = memory.alerts.slice(-ALERT_LIMIT);
  if (changed) {
    memory.updatedAt = Date.now();
    writeMemory(memory);
  }
  return memory;
}

function compact(v: bigint | undefined): string {
  if (v === undefined) return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return v.toString();
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)}q`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return v.toString();
}

function price(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return "-";
  if (v >= 1) return v.toFixed(6);
  if (v >= 0.000001) return v.toFixed(8);
  return v.toExponential(3);
}

function numericUnits(v: bigint, decimals: number): number | null {
  const safeDecimals = Math.min(30, Math.max(0, decimals));
  const scale = 10 ** safeDecimals;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isFinite(scale) || scale === 0) return null;
  const out = n / scale;
  return Number.isFinite(out) ? out : null;
}

function statusFor(token: string, alerts: RememberedAlert[], now: number): "LEAVE" | "WATCH" | "INFO" | "QUIET" {
  const recent = alerts.filter((a) => a.token.toLowerCase() === token.toLowerCase() && now - a.at < 15 * 60_000);
  if (recent.some((a) => a.level === "leave")) return "LEAVE";
  if (recent.some((a) => a.level === "warn")) return "WATCH";
  if (recent.some((a) => a.level === "info")) return "INFO";
  return "QUIET";
}

function viewSnapshot(s: Snapshot, alerts: RememberedAlert[], now: number) {
  const phase = s.phase === undefined ? "UNKNOWN" : (PHASE[s.phase] ?? String(s.phase));
  const pair = s.pairSymbol ?? "QUOTE";
  return {
    token: s.token,
    symbol: s.symbol,
    phase,
    status: statusFor(s.token, alerts, now),
    dev: s.devHoldPct,
    trades: s.trades,
    lastTradeAt: s.lastTradeAt,
    at: s.at,
    deployer: s.deployer ?? "",
    deployerLaunches: s.deployerLaunches,
    deployerGraduated: s.deployerGraduated ?? null,
    creatorTaxPct: s.creatorTaxBps === undefined ? null : s.creatorTaxBps / 100,
    pair,
    reserve: s.phase === 2 ? "-" : `${units(s.liquidityWei, s.pairDecimals ?? 18)} ${pair}`,
    price: s.phase === 2 ? `${price(s.poolPriceQuotePerToken)} ${pair}/token` : "-",
    liquidity: s.phase === 2 ? compact(s.poolLiquidity) : "-",
    quoteFees: `${units(s.feesPendingWei, s.pairDecimals ?? 18)} ${pair}`,
    tokenFees: s.poolPendingTokenFeesWei === undefined ? "-" : `${units(s.poolPendingTokenFeesWei, s.tokenDecimals ?? 18)} ${s.symbol}`,
    tick: s.poolTick ?? null,
  };
}

function makeReader(token?: string): Reader {
  const urls = rpcUrlList(CONFIG.rpcUrl, process.env.RPC_FALLBACK_URLS);
  return new FallbackReader(urls.map((rpcUrl) => new PonsV2Reader({
    rpcUrl,
    factory: CONFIG.ponsFactory as `0x${string}`,
    indexLookbackBlocks: CONFIG.indexLookbackBlocks,
    tradeLookbackBlocks: CONFIG.tradeLookbackBlocks,
    logChunkBlocks: CONFIG.logChunkBlocks,
    pinnedTokens: token ? [token as `0x${string}`] : [],
    discoveryMaxTokens: CONFIG.discoveryMaxTokens,
  })));
}

function worstStatus(alerts: Alert[]): "QUIET" | "WATCH" | "LEAVE" | "INFO" {
  if (alerts.some((a) => a.level === "leave")) return "LEAVE";
  if (alerts.some((a) => a.level === "warn")) return "WATCH";
  if (alerts.some((a) => a.level === "info")) return "INFO";
  return "QUIET";
}

function pctDelta(before: number | undefined, after: number | undefined): string | null {
  if (before === undefined || after === undefined || !Number.isFinite(before) || !Number.isFinite(after) || before === 0 || before === after) return null;
  const pct = ((after - before) / Math.abs(before)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function changeSummary(before: Snapshot | undefined, after: Snapshot): string[] {
  if (!before) return ["first snapshot stored"];
  const out: string[] = [];
  const devDelta = after.devHoldPct - before.devHoldPct;
  if (Math.abs(devDelta) >= 0.001) out.push(`deployer ${devDelta >= 0 ? "+" : ""}${devDelta.toFixed(2)} pts`);
  if (after.phase === 2 && before.phase === 2) {
    const p = pctDelta(before.poolPriceQuotePerToken, after.poolPriceQuotePerToken);
    if (p) out.push(`pool price ${p}`);
  } else if (before.liquidityWei > 0n && after.liquidityWei !== before.liquidityWei) {
    const pct = Number(((after.liquidityWei - before.liquidityWei) * 10_000n) / before.liquidityWei) / 100;
    if (Number.isFinite(pct)) out.push(`curve reserve ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
  }
  const trades = after.trades - before.trades;
  if (trades !== 0) out.push(`recent activity ${trades >= 0 ? "+" : ""}${trades}`);
  if (after.phase !== before.phase) out.push(`phase ${PHASE[before.phase ?? -1] ?? "UNKNOWN"} -> ${PHASE[after.phase ?? -1] ?? "UNKNOWN"}`);
  if (after.feesPendingWei !== before.feesPendingWei) out.push("quote fee state changed");
  return out.length ? out : ["state unchanged; snapshot still stored"];
}

async function persistSnapshot(after: Snapshot): Promise<{ before: Snapshot | undefined; alerts: Alert[] }> {
  let result: { before: Snapshot | undefined; alerts: Alert[] } | undefined;
  const task = writeQueue.then(async () => {
    const store = new Store(ROOT);
    const before = store.get(after.token);
    const alerts = evaluate(before, after, {
      devSellPct: CONFIG.devSellPct,
      liquidityDropPct: CONFIG.liquidityDropPct,
      volumeDeadMinutes: CONFIG.volumeDeadMinutes,
      serialDeployerCount: CONFIG.serialDeployerCount,
      poolLiquidityDropPct: CONFIG.poolLiquidityDropPct,
      poolPriceMovePct: CONFIG.poolPriceMovePct,
      poolSwapBurstCount: CONFIG.poolSwapBurstCount,
    }, after.at || Date.now());
    store.put(after);
    store.save();
    sampleMemory();
    result = { before, alerts };
  });
  writeQueue = task.then(() => undefined, () => undefined);
  await task;
  if (!result) throw new Error("snapshot persistence failed");
  return result;
}

function pushEvent(runtime: WatcherRuntime, event: SweepEvent): void {
  runtime.events.push(event);
  if (runtime.events.length > 80) runtime.events = runtime.events.slice(-80);
}

function scheduleWatcher(runtime: WatcherRuntime, delayMs: number): void {
  if (!watchers.has(runtime.token.toLowerCase())) return;
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.nextSweepAt = Date.now() + delayMs;
  runtime.timer = setTimeout(() => void runWatcher(runtime), delayMs);
}

async function runWatcher(runtime: WatcherRuntime): Promise<void> {
  if (!watchers.has(runtime.token.toLowerCase())) return;
  runtime.status = runtime.sweepCount === 0 ? "starting" : "running";
  const started = Date.now();
  runtime.nextSweepAt = 0;

  try {
    const after = await runtime.reader.snapshot(runtime.token);
    const persisted = await persistSnapshot(after);
    const durationMs = Date.now() - started;
    runtime.sweepCount += 1;
    runtime.lastSweepAt = Date.now();
    runtime.lastDurationMs = durationMs;
    runtime.lastError = "";
    runtime.consecutiveErrors = 0;
    runtime.status = "running";
    pushEvent(runtime, {
      at: runtime.lastSweepAt,
      sweep: runtime.sweepCount,
      durationMs,
      status: worstStatus(persisted.alerts),
      changes: changeSummary(persisted.before, after),
      message: `${after.symbol} / ${PHASE[after.phase ?? -1] ?? "UNKNOWN"} / ${persisted.alerts.length} signal(s)`,
    });
    scheduleWatcher(runtime, WATCH_INTERVAL_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    runtime.consecutiveErrors += 1;
    runtime.lastDurationMs = durationMs;
    runtime.lastError = message;
    runtime.status = "retrying";
    pushEvent(runtime, {
      at: Date.now(),
      sweep: runtime.sweepCount + 1,
      durationMs,
      status: "ERROR",
      changes: [],
      message,
    });
    const permanent = /not a launch from the configured Pons V2 factory|not a valid/i.test(message);
    if (permanent) {
      watchers.delete(runtime.token.toLowerCase());
      writeWatchlist();
      return;
    }
    const retryMs = Math.min(60_000, WATCH_INTERVAL_MS * Math.max(1, runtime.consecutiveErrors));
    scheduleWatcher(runtime, retryMs);
  }
}

function watcherState() {
  return [...watchers.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((w) => ({
      token: w.token,
      startedAt: w.startedAt,
      status: w.status,
      lastSweepAt: w.lastSweepAt,
      nextSweepAt: w.nextSweepAt,
      lastDurationMs: w.lastDurationMs,
      lastError: w.lastError || null,
      sweepCount: w.sweepCount,
      events: [...w.events].reverse().slice(0, 40),
    }));
}

function startWatcher(token: string, persist = true): { ok: true; started: boolean } | { ok: false; error: string } {
  const clean = token.trim();
  if (!isAddress(clean)) return { ok: false, error: "not a valid EVM address" };
  const key = clean.toLowerCase();
  if (watchers.has(key)) return { ok: true, started: false };

  const runtime: WatcherRuntime = {
    token: clean,
    startedAt: Date.now(),
    status: "starting",
    reader: makeReader(clean),
    lastSweepAt: 0,
    nextSweepAt: 0,
    lastDurationMs: 0,
    lastError: "",
    consecutiveErrors: 0,
    sweepCount: 0,
    events: [],
  };
  watchers.set(key, runtime);
  if (persist) writeWatchlist();
  void runWatcher(runtime);
  return { ok: true, started: true };
}

function stopWatcher(token: string): { ok: true; stopped: boolean } | { ok: false; error: string } {
  const key = token.trim().toLowerCase();
  const runtime = watchers.get(key);
  if (!runtime) return { ok: true, stopped: false };
  if (runtime.timer) clearTimeout(runtime.timer);
  watchers.delete(key);
  writeWatchlist();
  return { ok: true, stopped: true };
}

async function probeRpc(): Promise<void> {
  try {
    const health = await makeReader().health();
    rpcHealth = health.ok
      ? { status: "ok", checkedAt: Date.now(), chainId: health.chainId, block: health.block?.toString() }
      : { status: "error", checkedAt: Date.now(), error: health.error ?? "RPC health check failed" };
  } catch (err) {
    rpcHealth = { status: "error", checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
}

function apiState() {
  const store = storeState();
  const memory = sampleMemory();
  const now = Date.now();
  const positions = Object.values(store.positions)
    .filter((s) => isAddress(s.token))
    .sort((a, b) => b.at - a.at)
    .map((s) => viewSnapshot(s, memory.alerts, now));
  const alerts = [...memory.alerts].sort((a, b) => b.at - a.at).slice(0, 300);
  const histories: Record<string, unknown[]> = {};
  for (const [token, samples] of Object.entries(memory.samples)) {
    if (!isAddress(token)) continue;
    histories[token] = samples.slice(-360).map((s) => ({
      at: s.at,
      dev: s.devHoldPct,
      trades: s.trades,
      phase: s.phase === undefined ? "UNKNOWN" : (PHASE[s.phase] ?? String(s.phase)),
      price: s.poolPriceQuotePerToken ?? null,
      reserve: s.phase === 2 ? null : numericUnits(s.liquidityWei, s.pairDecimals ?? 18),
      quoteFees: numericUnits(s.feesPendingWei, s.pairDecimals ?? 18),
      tokenFees: s.poolPendingTokenFeesWei === undefined ? null : numericUnits(s.poolPendingTokenFeesWei, s.tokenDecimals ?? 18),
    }));
  }
  return {
    generatedAt: now,
    writerUpdatedAt: store.updatedAt,
    memoryUpdatedAt: memory.updatedAt,
    stats: {
      tracked: positions.length,
      leave: alerts.filter((a) => a.level === "leave" && now - a.at < 86_400_000).length,
      watch: alerts.filter((a) => a.level === "warn" && now - a.at < 86_400_000).length,
      samples: Object.values(memory.samples).reduce((n, xs) => n + xs.length, 0),
      activeWatchers: watchers.size,
    },
    positions,
    alerts,
    histories,
    watchers: watcherState(),
    rpc: rpcHealth,
    creatorX: CREATOR_X,
    control: { mode: CONTROL_TOKEN ? "key" : "local-only", remoteWritesRequireKey: true },
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, replacer);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function text(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(value);
}

function readBody(req: IncomingMessage, limit = 2_048): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) reject(new Error("request too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

const port = Math.max(1, Math.min(65535, Number.parseInt(parseArg("--port", "4663"), 10) || 4663));
const host = parseArg("--host", "127.0.0.1");
const CONTROL_TOKEN = process.env.CANARY_CONTROL_TOKEN?.trim() || "";

function headerText(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

function requestControlAllowed(req: IncomingMessage): boolean {
  return controlAuthorized({
    boundHost: host,
    configuredToken: CONTROL_TOKEN,
    suppliedToken: headerText(req, "x-canary-control"),
    forwardedFor: headerText(req, "x-forwarded-for"),
    remoteAddress: req.socket.remoteAddress ?? "",
  });
}

const PUBLIC_SCAN_WINDOW_MS = 60_000;
const PUBLIC_SCAN_LIMIT = 12;
const PUBLIC_SCAN_CACHE_MS = 15_000;
const publicScanWindows = new Map<string, { startedAt: number; count: number }>();
const publicScanCache = new Map<string, { at: number; value: unknown }>();

function publicClientIp(req: IncomingMessage): string {
  const forwarded = headerText(req, "x-forwarded-for").split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function takePublicScanBudget(req: IncomingMessage): { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const key = publicClientIp(req);
  const window = publicScanWindows.get(key);

  if (!window || now - window.startedAt >= PUBLIC_SCAN_WINDOW_MS) {
    publicScanWindows.set(key, { startedAt: now, count: 1 });
    return { ok: true, remaining: PUBLIC_SCAN_LIMIT - 1 };
  }

  if (window.count >= PUBLIC_SCAN_LIMIT) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((PUBLIC_SCAN_WINDOW_MS - (now - window.startedAt)) / 1000)),
    };
  }

  window.count += 1;
  return { ok: true, remaining: PUBLIC_SCAN_LIMIT - window.count };
}

async function scanPublicToken(token: string): Promise<{ snapshot: unknown; cached: boolean }> {
  const key = token.toLowerCase();
  const cached = publicScanCache.get(key);

  if (cached && Date.now() - cached.at < PUBLIC_SCAN_CACHE_MS) {
    return { snapshot: cached.value, cached: true };
  }

  const after = await makeReader(token).snapshot(token);
  const value = viewSnapshot(after, [], Date.now());
  publicScanCache.set(key, { at: Date.now(), value });

  if (publicScanCache.size > 250) {
    const cutoff = Date.now() - PUBLIC_SCAN_CACHE_MS * 4;
    for (const [cacheKey, entry] of publicScanCache) {
      if (entry.at < cutoff) publicScanCache.delete(cacheKey);
    }
  }

  return { snapshot: value, cached: false };
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#080a07">
<meta name="description" content="Canary is a read-only Pons V2 watchtower for Robinhood Chain. Scan a token and inspect live on-chain state without a signer.">
<title>Canary v0.4 - Robinhood Chain watchtower</title>
<style>
:root{
  --bg:#080a07;--panel:#0f120d;--panel2:#13170f;--line:#293023;--line2:#354027;
  --text:#edf1e7;--muted:#818a79;--lime:#b7ff00;--lime2:#84b900;--red:#ff625a;
  --yellow:#eadb63;--cyan:#61caff;--shadow:0 18px 60px rgba(0,0,0,.28)
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:76px}
body{
  margin:0;color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;
  background:
    radial-gradient(900px 460px at 50% -180px,rgba(183,255,0,.10),transparent 62%),
    linear-gradient(rgba(255,255,255,.014) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.014) 1px,transparent 1px),var(--bg);
  background-size:auto,48px 48px,48px 48px
}
button,input{font:inherit}
a{color:inherit}
.siteNav{position:sticky;top:0;z-index:40;background:rgba(8,10,7,.88);backdrop-filter:blur(14px);border-bottom:1px solid rgba(183,255,0,.12)}
.siteNavInner{max-width:1500px;margin:0 auto;padding:11px 16px;display:flex;align-items:center;gap:18px}
.navBrand{font:700 18px Georgia,serif;text-decoration:none}.navBrand strong{color:var(--lime);font:700 12px ui-monospace;margin-right:8px}
.navLinks{display:flex;gap:18px;margin-left:auto;align-items:center}
.navLinks a{color:var(--muted);font-size:11px;text-decoration:none}.navLinks a:hover{color:var(--text)}
.navCta{border:1px solid #466500!important;color:var(--lime)!important;border-radius:999px;padding:6px 10px}
.hero{max-width:1500px;margin:0 auto;padding:70px 16px 34px;position:relative;overflow:hidden}
.hero:after{content:"";position:absolute;right:-130px;top:-250px;width:520px;height:520px;border:1px solid rgba(183,255,0,.08);border-radius:50%;box-shadow:0 0 0 74px rgba(183,255,0,.016),0 0 0 148px rgba(183,255,0,.010);pointer-events:none}
.eyebrow{display:flex;align-items:center;gap:9px;color:var(--lime);text-transform:uppercase;letter-spacing:.15em;font-size:10px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--lime);box-shadow:0 0 15px var(--lime);animation:pulse 2s infinite}
@keyframes pulse{50%{opacity:.35;box-shadow:0 0 4px var(--lime)}}
.heroTitle{font:700 clamp(78px,11vw,156px)/.82 Georgia,serif;letter-spacing:-.07em;margin:18px 0 0;color:#f7f9f2}
.heroTitle span{color:var(--lime)}.heroTitle small{font:700 .14em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;color:#a7b09e;margin-left:18px;vertical-align:top}
.heroCopy{max-width:830px;margin:28px 0 24px;color:#adb5a4;font-size:18px;line-height:1.65}
.heroCopy strong{color:var(--text)}
.heroActions{display:flex;gap:10px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:9px;padding:10px 14px;text-decoration:none;font-weight:800}
.btn.primary{background:var(--lime);color:#080a07}.btn.secondary{border:1px solid var(--line2);background:#0c0f0a;color:var(--text)}
.creator{margin-top:20px;color:var(--muted);font-size:11px}.creator a{color:var(--text);text-decoration:none;border-bottom:1px solid #405519}.creator a:hover{color:var(--lime)}
.heroMeta{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:46px}
.heroMetaCard{border-top:1px solid var(--line);padding:14px 14px;color:var(--muted);font-size:10px;line-height:1.5}
.heroMetaCard b{display:block;color:var(--text);font-size:12px;margin-bottom:5px}
.wrap{max-width:1500px;margin:0 auto;padding:18px 16px}
.top{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding:0 0 12px}
.brand{font:20px Georgia,serif}.sub{color:var(--muted);font-size:10px}.pill{border:1px solid #466500;color:var(--lime);border-radius:999px;padding:5px 9px;font-size:10px}
.spacer{flex:1}.heartbeat{font-size:10px;color:var(--muted);text-align:right}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:14px 0}
.card,.panel,.sectionCard{background:linear-gradient(180deg,var(--panel),#0b0e09);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.card{padding:14px 15px}.num{font:26px Georgia,serif}.label{font-size:10px;color:var(--muted);margin-top:3px}
.layout{display:grid;grid-template-columns:minmax(0,2.05fr) minmax(380px,.95fr);gap:12px;align-items:start}
.panel{overflow:hidden}.panel h2{font:18px Georgia,serif;margin:0;padding:14px 16px;border-bottom:1px solid var(--line)}
.watchbar,.tools{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.watchbar{background:#0b0e09}.watchbar input{flex:1}
input{width:100%;background:#080b07;color:var(--text);border:1px solid var(--line2);border-radius:8px;padding:9px 10px;outline:none}
input:focus{border-color:#728f19;box-shadow:0 0 0 2px rgba(183,255,0,.05)}
.watchbtn{background:var(--lime);color:#070907;border:0;border-radius:8px;padding:9px 13px;font-weight:900;cursor:pointer;white-space:nowrap}
.watchbtn:disabled{opacity:.45;cursor:default}
.watchmsg{font-size:10px;color:var(--muted);padding:0 12px 10px;background:#0b0e09;min-height:24px}
.watchmsg.ok{color:#9cf980}.watchmsg.err{color:var(--red)}
.watcherRail{display:flex;gap:7px;flex-wrap:wrap;padding:0 12px 10px;background:#0b0e09}
.watcherChip{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:5px 8px;font-size:9px;color:var(--muted)}
.watcherChip.running{border-color:#405b10;color:#b7d98c}.watcherChip.retrying{border-color:#5f5224;color:#eadb63}.watcherChip.error{border-color:#5f2624;color:#ff9b96}
.stopBtn{border:0;background:transparent;color:var(--red);cursor:pointer;padding:0 2px}
.tabs{display:flex;gap:6px}.tab{background:#0e120c;border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:6px 9px;cursor:pointer}
.tab.on{color:#070907;background:var(--lime);border-color:var(--lime)}
.scroll{overflow:auto;max-height:660px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid #20261d;white-space:nowrap}
th{font-size:9px;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.05em}
tbody tr{cursor:pointer}tbody tr:hover,tbody tr.sel{background:#171c12}
.sym{font-weight:800}.addr{color:var(--muted);font-size:9px}.phase{color:var(--cyan)}
.badge{display:inline-block;padding:2px 6px;border-radius:5px;font-size:9px}.QUIET{color:#8cff72}.WATCH{color:var(--yellow)}.LEAVE{color:var(--red)}.INFO{color:var(--cyan)}
.bar{height:4px;background:#252c20;border-radius:9px;overflow:hidden;width:72px;display:inline-block;vertical-align:middle;margin-left:6px}.bar i{display:block;height:100%;background:var(--lime)}
.detail{padding:14px}.detailHead{font:23px Georgia,serif;margin-bottom:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin:14px 0}
.kv{border-top:1px solid var(--line);padding-top:7px}.kv b{display:block;font-size:9px;color:var(--muted);font-weight:500;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}
.memoryTitle{font:16px Georgia,serif;margin:16px 0 8px}
.charts{display:grid;grid-template-columns:1fr;gap:10px}
.chartCard{border:1px solid var(--line);border-radius:9px;background:#080b07;padding:9px}
.chartHead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px}.chartHead span:first-child{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.04em}.chartValue{font-size:10px;color:var(--text)}
.spark{width:100%;height:86px;display:block}.chartGrid{stroke:#22291d;stroke-width:1}.chartLine{fill:none;stroke:var(--lime);stroke-width:2;vector-effect:non-scaling-stroke}.chartArea{fill:rgba(183,255,0,.045)}
.livePoint{fill:var(--lime);filter:drop-shadow(0 0 5px var(--lime));animation:pointPulse 1.8s infinite}@keyframes pointPulse{50%{opacity:.35}}
.chartTimes{display:flex;justify-content:space-between;color:#626b5c;font-size:8px;margin-top:2px}
.liveStrip{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:12px 0}.liveCell{border:1px solid var(--line);border-radius:8px;background:#090c08;padding:8px}.liveCell b{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.liveCell span{font-size:10px}.liveDot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--lime);box-shadow:0 0 8px var(--lime);margin-right:5px}.monitorGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0 2px}.monitorItem{border:1px solid var(--line);border-radius:8px;padding:8px;background:#090c08}.monitorItem b{display:block;font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}.monitorItem span{font-size:9px;color:#cfd6c7}.liveFeed{border:1px solid var(--line);border-radius:9px;overflow:hidden;background:#080b07}.feedRow{padding:9px 10px;border-bottom:1px solid #20261d}.feedRow:last-child{border-bottom:0}.feedTop{display:flex;justify-content:space-between;gap:10px;font-size:9px}.feedMeta{color:var(--muted)}.feedChanges{color:#aab3a1;font-size:9px;margin-top:4px;line-height:1.5}.rowLive{display:inline-flex;align-items:center;gap:4px;margin-left:6px;color:var(--lime);font-size:8px}.rowLive i{width:5px;height:5px;border-radius:50%;background:var(--lime);box-shadow:0 0 6px var(--lime)}.chartSampleMeta{color:#626b5c;font-size:8px}.point{fill:var(--lime);opacity:.33}.pendingBox{border:1px solid #405519;border-radius:10px;background:rgba(183,255,0,.035);padding:14px;color:#aab3a1;line-height:1.6}.pendingBox b{color:var(--lime);display:block;margin-bottom:6px}.event{border-top:1px solid var(--line);padding:9px 0}.event small{color:var(--muted)}.eventDelta{color:var(--text);font-size:10px;margin-top:3px}
.empty{padding:40px;color:var(--muted);text-align:center}
.story{margin:88px 0 0}.storyHead{display:grid;grid-template-columns:.85fr 1.15fr;gap:42px;align-items:end;margin-bottom:28px}
.kicker{color:var(--lime);font-size:9px;text-transform:uppercase;letter-spacing:.15em}.storyTitle{font:500 clamp(34px,4vw,58px)/1.02 Georgia,serif;letter-spacing:-.025em;margin:7px 0 0}
.storyLead{color:#9ba490;line-height:1.75;font-size:13px;max-width:720px;margin:0 0 4px auto}
.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.flowStep{min-height:210px;padding:20px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(145deg,#12170f,#0b0e09);position:relative}
.flowNo{font:12px Georgia,serif;color:var(--lime);margin-bottom:52px}.flowStep h3{font:18px Georgia,serif;margin:0 0 8px}.flowStep p{color:var(--muted);font-size:10px;line-height:1.65;margin:0}
.coverage{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.coverCard{padding:20px;border:1px solid var(--line);border-radius:12px;background:#0c0f0a}
.coverIcon{width:38px;height:38px;border:1px solid #405519;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--lime);margin-bottom:26px;font-weight:800}.coverCard h3{font:17px Georgia,serif;margin:0 0 8px}.coverCard p{margin:0;color:var(--muted);line-height:1.65;font-size:10px}
.signalBand{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.signalCard{padding:24px;border:1px solid var(--line);border-radius:12px;background:#0c0f0a}.signalName{font:24px Georgia,serif;margin-bottom:12px}.signalCard p{color:var(--muted);line-height:1.65;font-size:10px}
.memoryWrap{display:grid;grid-template-columns:1.1fr .9fr;gap:12px}.memoryViz,.memoryCopy{border:1px solid var(--line);border-radius:12px;background:#0c0f0a;padding:24px}
.memoryNode{display:grid;grid-template-columns:20px 1fr;gap:15px;margin-bottom:28px}.memoryNode i{width:9px;height:9px;background:var(--lime);border-radius:50%;margin-top:4px;box-shadow:0 0 12px rgba(183,255,0,.4)}.memoryNode b{display:block;font-size:12px;margin-bottom:5px}.memoryNode span{color:var(--muted);font-size:10px}
.memoryCopy h3{font:28px Georgia,serif;margin:0 0 18px}.memoryCopy p{color:#9ba490;line-height:1.75}.memoryCode{border:1px solid var(--line);background:#070907;border-radius:9px;padding:14px;font-size:10px;color:#adb5a4;line-height:1.9}.memoryCode strong{color:var(--lime)}
.safety{display:grid;grid-template-columns:1fr 1fr;gap:12px}.safetyBig{padding:30px;border:1px solid #405519;border-radius:12px;background:linear-gradient(135deg,rgba(183,255,0,.055),#0c0f0a)}
.safetyBig h3{font:34px Georgia,serif;margin:0 0 12px}.safetyBig p{color:#9ba490;line-height:1.75}.safetyList{display:grid;grid-template-columns:1fr 1fr;gap:10px}.safetyItem{border:1px solid var(--line);border-radius:10px;padding:18px;background:#0c0f0a}.safetyItem b{display:block;color:var(--lime);margin-bottom:8px}.safetyItem span{color:var(--muted);font-size:10px}
.footer{margin:80px 0 24px;padding:24px 2px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font-size:10px}.footer b{color:var(--text);font:16px Georgia,serif}
@media(max-width:1050px){.layout,.storyHead,.memoryWrap,.safety{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}.coverage{grid-template-columns:1fr 1fr}.storyLead{margin:0}.heroMeta{grid-template-columns:1fr 1fr}.navLinks a:not(.navCta){display:none}}
@media(max-width:700px){.hero{padding-top:48px}.heroTitle{font-size:68px}.heroCopy{font-size:15px}.heroMeta,.stats,.flow,.coverage,.signalBand,.safetyList,.liveStrip,.monitorGrid{grid-template-columns:1fr}.tools,.watchbar{flex-direction:column}.footer{display:block}.footer span{display:block;margin-top:10px}}

/* v0.4 public product polish */
.cursorGlow{
  position:fixed;z-index:0;left:0;top:0;width:420px;height:420px;border-radius:50%;
  pointer-events:none;background:radial-gradient(circle,rgba(183,255,0,.075),rgba(183,255,0,.018) 38%,transparent 68%);
  filter:blur(14px);transform:translate(-999px,-999px);opacity:.9
}
.siteNav,.hero,.wrap,.ticker{position:relative;z-index:1}
.heroTitle{text-shadow:0 0 42px rgba(183,255,0,.045)}

.scanHero{
  position:relative;max-width:1040px;margin:30px 0 20px;border:1px solid #3d4d25;border-radius:16px;
  background:linear-gradient(145deg,rgba(19,24,15,.96),rgba(8,11,7,.96));
  box-shadow:0 28px 90px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.025);overflow:hidden
}
.scanHero:before{
  content:"";position:absolute;left:-25%;top:0;width:25%;height:1px;
  background:linear-gradient(90deg,transparent,var(--lime),transparent);
  box-shadow:0 0 18px rgba(183,255,0,.75);animation:scanBeam 4.8s ease-in-out infinite
}
@keyframes scanBeam{0%,15%{left:-25%;opacity:0}30%{opacity:1}70%{opacity:.8}85%,100%{left:110%;opacity:0}}
.scanTop{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 15px;border-bottom:1px solid var(--line);color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.12em}
.scanTop b{color:var(--lime);font-weight:700}.scanTop span:last-child{color:#687161}
.scanForm{display:grid;grid-template-columns:1fr auto;gap:9px;padding:14px}
.scanForm input{height:48px;border-radius:10px;padding:0 14px;background:#070907;font-size:12px}
.scanBtn{min-width:138px;border:0;border-radius:10px;background:var(--lime);color:#080a07;font-weight:950;cursor:pointer;padding:0 18px;transition:transform .18s ease,box-shadow .18s ease}
.scanBtn:hover{transform:translateY(-1px);box-shadow:0 8px 30px rgba(183,255,0,.16)}
.scanBtn:disabled{opacity:.5;cursor:default;transform:none;box-shadow:none}
.scanMsg{padding:0 15px 14px;color:var(--muted);font-size:10px;min-height:26px}
.scanMsg.err{color:var(--red)}.scanMsg.ok{color:#9cf980}
.scanResult{display:none;margin:0 14px 14px;border-top:1px solid var(--line);padding-top:14px}
.scanResult.on{display:block;animation:resultIn .35s ease both}
@keyframes resultIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.scanResultHead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:12px}
.scanResultHead h3{font:30px Georgia,serif;margin:3px 0 0}
.scanTag{color:var(--lime);border:1px solid #405519;border-radius:999px;padding:5px 8px;font-size:8px}
.scanGrid{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}
.scanCell{border:1px solid #22291d;border-radius:9px;background:#080b07;padding:10px;min-width:0}
.scanCell b{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.scanCell span{display:block;color:#edf1e7;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scanFoot{color:#687161;font-size:9px;line-height:1.6;margin-top:10px}

.ticker{overflow:hidden;border-top:1px solid rgba(183,255,0,.11);border-bottom:1px solid rgba(183,255,0,.11);background:#090c08}
.tickerTrack{display:flex;width:max-content;gap:36px;padding:9px 0;color:#7f8977;font-size:9px;letter-spacing:.12em;text-transform:uppercase;animation:tickerMove 28s linear infinite}
.tickerTrack b{color:var(--lime);font-weight:600}
@keyframes tickerMove{to{transform:translateX(-50%)}}

.card,.heroMetaCard,.flowStep,.coverCard,.signalCard,.memoryViz,.memoryCopy,.safetyBig,.safetyItem{
  transition:transform .2s ease,border-color .2s ease,background .2s ease
}
.card:hover,.heroMetaCard:hover,.flowStep:hover,.coverCard:hover,.signalCard:hover,.safetyItem:hover{
  transform:translateY(-2px);border-color:#405519
}
.reveal{opacity:0;transform:translateY(18px);transition:opacity .65s ease,transform .65s ease}
.reveal.in{opacity:1;transform:none}

@media(max-width:1050px){.scanGrid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.scanGrid{grid-template-columns:1fr}.scanForm{grid-template-columns:1fr}.scanBtn{height:46px}.cursorGlow{display:none}}
@media(prefers-reduced-motion:reduce){.scanHero:before,.tickerTrack{animation:none}.reveal{opacity:1;transform:none;transition:none}}


/* v0.4 cinematic product pass */
:root{
  --lime:#f4d817;
  --lime2:#bca80b;
  --canary:#f4d817;
  --ink:#080806;
  --paper:#f3f0df;
}
body{
  background:
    radial-gradient(850px 480px at 48% -180px,rgba(244,216,23,.105),transparent 62%),
    linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px),var(--bg);
}
.siteNav{border-bottom-color:rgba(244,216,23,.12)}
.navBrand strong,.eyebrow,.kicker{color:var(--canary)}
.navCta{border-color:#6b6113!important;color:var(--canary)!important}
.hero:after{border-color:rgba(244,216,23,.09);box-shadow:0 0 0 74px rgba(244,216,23,.015),0 0 0 148px rgba(244,216,23,.009)}
.heroTitle span{color:var(--canary)}
.dot,.liveDot{background:var(--canary);box-shadow:0 0 15px rgba(244,216,23,.65)}
.btn.primary,.watchbtn,.scanBtn,.tab.on{background:var(--canary);border-color:var(--canary);color:#080806}
.scanHero{border-color:#514b1a;background:linear-gradient(145deg,rgba(22,21,13,.96),rgba(8,9,6,.96))}
.scanHero:before{background:linear-gradient(90deg,transparent,var(--canary),transparent);box-shadow:0 0 18px rgba(244,216,23,.72)}
.scanTop b,.scanTag{color:var(--canary)}
.ticker{border-color:rgba(244,216,23,.12)}
.tickerTrack b{color:var(--canary)}
.chartLine{stroke:var(--canary)}.chartArea{fill:rgba(244,216,23,.045)}
.livePoint,.point{fill:var(--canary)}
.bar i{background:var(--canary)}
.coverIcon,.memoryCode strong,.safetyItem b{color:var(--canary)}
.memoryNode i{background:var(--canary);box-shadow:0 0 12px rgba(244,216,23,.35)}

body.publicHost .watchbar,
body.publicHost .watchmsg,
body.publicHost .watcherRail{display:none}

.film{
  margin:26px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);
  background:#080906;position:relative;overflow:hidden
}
.filmInner{max-width:1500px;margin:0 auto;padding:20px 16px 26px}
.filmHead{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:16px}
.filmIndex{font:13px Georgia,serif;color:var(--canary)}
.filmTitle{font:500 clamp(32px,4vw,58px)/1 Georgia,serif;letter-spacing:-.035em;margin:4px 0 0}
.filmMeta{text-align:right;color:var(--muted);font-size:9px;line-height:1.6}
.filmScreen{
  position:relative;min-height:440px;border:1px solid #343327;border-radius:14px;overflow:hidden;
  background:
    radial-gradient(600px 280px at 72% 45%,rgba(244,216,23,.09),transparent 70%),
    #070806
}
.filmScreen:before{
  content:"";position:absolute;inset:0;pointer-events:none;opacity:.18;
  background:repeating-linear-gradient(180deg,transparent 0,transparent 3px,rgba(255,255,255,.018) 4px)
}
.filmTop{display:flex;justify-content:space-between;align-items:center;padding:11px 13px;border-bottom:1px solid #25261f;color:#7d8376;font-size:9px}
.filmTop b{color:var(--canary);letter-spacing:.11em}
.filmStage{display:grid;grid-template-columns:.92fr 1.08fr;min-height:390px}
.filmNarrative{padding:32px;border-right:1px solid #25261f;display:flex;flex-direction:column;justify-content:space-between}
.filmBeat{font:500 clamp(32px,4vw,68px)/.95 Georgia,serif;letter-spacing:-.045em;max-width:620px}
.filmBeat em{font-style:normal;color:var(--canary)}
.filmSub{max-width:520px;color:#8b9284;font-size:11px;line-height:1.8}
.filmTerminal{padding:26px 28px;font-size:11px;line-height:1.8;display:flex;flex-direction:column;justify-content:center}
.filmLine{display:flex;gap:10px;color:#a9afa1;opacity:.46;transform:translateY(3px);transition:opacity .35s ease,transform .35s ease}
.filmLine.on{opacity:1;transform:none}.filmLine b{min-width:72px;color:#5e6559;font-weight:500}.filmLine strong{color:#eef0e8}
.filmLine.warn strong{color:var(--yellow)}.filmLine.leave strong{color:var(--red)}
.filmProgress{height:2px;background:#1c1e19}.filmProgress i{display:block;height:100%;width:0;background:var(--canary)}
.film.playing .filmProgress i{animation:filmProgress 20s linear infinite}
@keyframes filmProgress{from{width:0}to{width:100%}}
.filmPause{border:0;background:transparent;color:#8d9386;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:3px}

.pulseBand{margin:54px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);display:grid;grid-template-columns:1.3fr repeat(4,.7fr)}
.pulseIntro,.pulseMetric{padding:22px 18px;min-height:112px}
.pulseIntro{border-right:1px solid var(--line)}.pulseMetric{border-right:1px solid var(--line)}
.pulseMetric:last-child{border-right:0}.pulseIntro b{font:26px Georgia,serif}.pulseIntro p{color:var(--muted);font-size:10px;line-height:1.6;margin:9px 0 0}
.pulseMetric span{display:block;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.09em}
.pulseMetric strong{display:block;font:28px Georgia,serif;margin-top:12px;color:var(--text)}
.pulseMetric strong.live{color:var(--canary)}

.changed{margin:92px 0 0}
.changedGrid{display:grid;grid-template-columns:1fr 70px 1fr;gap:12px;align-items:stretch}
.stateCard{border:1px solid var(--line);border-radius:12px;background:#0b0e09;padding:22px}
.stateCardHead{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.09em}
.stateCardHead b{color:var(--text)}
.stateRows{display:grid;gap:0}
.stateRow{display:grid;grid-template-columns:1fr auto;gap:20px;padding:12px 0;border-top:1px solid #21251e;font-size:10px}
.stateRow span{color:var(--muted)}.stateRow strong{font-weight:600}.stateRow.changedVal strong{color:var(--canary)}
.changeArrow{display:flex;align-items:center;justify-content:center;color:var(--canary);font-size:28px}
.changedCallout{margin-top:12px;border-left:2px solid var(--canary);padding:14px 16px;background:rgba(244,216,23,.025);color:#aab0a2;font-size:10px;line-height:1.7}
.changedCallout b{color:var(--text)}

.refusals{display:grid;grid-template-columns:.75fr 1.25fr;gap:30px;margin-top:26px}
.refusalLead{font:500 clamp(30px,3.3vw,48px)/1.02 Georgia,serif;letter-spacing:-.03em}
.refusalList{border-top:1px solid var(--line)}
.refusalRow{display:grid;grid-template-columns:180px 1fr;gap:18px;padding:15px 0;border-bottom:1px solid var(--line);font-size:10px}
.refusalRow code{color:var(--red)}.refusalRow span{color:#9aa292;line-height:1.6}

.adminControl{display:none!important}
.siteNavInner{max-width:1500px}
.navLinks a{letter-spacing:.02em}
.footerDomain{color:var(--canary)}

@media(max-width:1000px){
  .filmStage,.refusals{grid-template-columns:1fr}
  .filmNarrative{border-right:0;border-bottom:1px solid #25261f;min-height:300px}
  .pulseBand{grid-template-columns:1fr 1fr}.pulseIntro{grid-column:1/-1}
  .changedGrid{grid-template-columns:1fr}.changeArrow{transform:rotate(90deg);min-height:45px}
}
@media(max-width:650px){
  .filmHead{display:block}.filmMeta{text-align:left;margin-top:10px}
  .filmNarrative,.filmTerminal{padding:20px}.filmScreen{min-height:0}
  .pulseBand{grid-template-columns:1fr}.pulseIntro{grid-column:auto}.pulseIntro,.pulseMetric{border-right:0;border-bottom:1px solid var(--line)}
  .refusalRow{grid-template-columns:1fr;gap:5px}
}

</style>
</head>
<body>
<div id="cursorGlow" class="cursorGlow"></div>
<div class="siteNav"><div class="siteNavInner"><a class="navBrand" href="#overview"><strong>C</strong>Canary v0.4</a><div class="navLinks"><a href="#overview">scan</a><a href="#film">film</a><a href="#desk">live desk</a><a href="#how">how</a><a href="https://github.com/Gipppp121/canary" target="_blank" rel="noreferrer">github</a><a class="navCta" href="#overview">scan a token</a></div></div></div>

<header class="hero" id="overview">
  <div class="eyebrow"><span class="dot"></span> live read-only monitoring for Pons V2</div>
  <h1 class="heroTitle">CAN<span>ARY</span><small>v0.4</small></h1>
  <p class="heroCopy">Paste a Pons V2 token. Canary reads the live chain without a wallet, shows the current state, and can keep a persistent memory of <strong>what changed between sweeps</strong>.</p>
  <div class="scanHero">
    <div class="scanTop"><b>public chain scan</b><span>Robinhood Chain / 4663 / no signer</span></div>
    <div class="scanForm"><input id="publicScanToken" autocomplete="off" spellcheck="false" placeholder="0x... paste a Pons V2 token address"><button id="publicScanBtn" class="scanBtn">SCAN TOKEN</button></div>
    <div id="publicScanMsg" class="scanMsg">One read-only snapshot. Nothing is signed, stored, bought, or sold.</div>
    <div id="publicScanResult" class="scanResult"></div>
  </div>
  <div class="heroActions"><a class="btn primary" href="#desk">open live desk</a><a class="btn secondary" href="#how">see how it works</a><a class="btn secondary" href="https://github.com/Gipppp121/canary" target="_blank" rel="noreferrer">view source</a></div>
  <div class="creator">Created by <a id="creatorLink" href="https://x.com/gippp69" target="_blank" rel="noreferrer">@gippp69 on X</a></div>
  <div class="heroMeta">
    <div class="heroMetaCard"><b>READ ONLY</b>no signer or transaction path</div>
    <div class="heroMetaCard"><b>PERSISTENT MEMORY</b>snapshots survive browser restarts</div>
    <div class="heroMetaCard"><b>DETERMINISTIC</b>every alert maps to a plain source rule</div>
    <div class="heroMetaCard"><b>PUBLIC SCAN</b>one live snapshot without starting a watcher</div>
  </div>
</header>


<div class="ticker"><div class="tickerTrack">
  <span><b>CHAIN 4663</b> / ROBINHOOD CHAIN</span><span>PONS V2 / LIVE STATE</span><span><b>NO SIGNER</b> / NO PRIVATE KEY</span><span>PERSISTENT MEMORY / BEFORE -> AFTER</span><span>POOL LIQUIDITY / PRICE / SWAPS / FEES</span>
  <span><b>CHAIN 4663</b> / ROBINHOOD CHAIN</span><span>PONS V2 / LIVE STATE</span><span><b>NO SIGNER</b> / NO PRIVATE KEY</span><span>PERSISTENT MEMORY / BEFORE -> AFTER</span><span>POOL LIQUIDITY / PRICE / SWAPS / FEES</span>
</div></div>


<section class="film playing" id="film">
  <div class="filmInner">
    <div class="filmHead">
      <div><div class="filmIndex">00 / twenty seconds</div><h2 class="filmTitle">one sweep becomes a memory.</h2></div>
      <div class="filmMeta">product sequence / no token required<br><button id="filmPause" class="filmPause" type="button">click to pause</button></div>
    </div>
    <div class="filmScreen">
      <div class="filmTop"><b>CANARY / READ-ONLY WATCHTOWER</b><span id="filmClock">00:00 / 00:20</span></div>
      <div class="filmStage">
        <div class="filmNarrative">
          <div id="filmBeat" class="filmBeat">read the chain.<br><em>save the state.</em></div>
          <div id="filmSub" class="filmSub">Canary starts with one current snapshot. No signer, no wallet prompt, no transaction path.</div>
        </div>
        <div class="filmTerminal" id="filmTerminal">
          <div class="filmLine on"><b>00:00</b><strong>RPC / chain 4663 / block acquired</strong></div>
          <div class="filmLine"><b>00:04</b><strong>snapshot / deployer / market / activity / fees</strong></div>
          <div class="filmLine"><b>00:08</b><strong>memory / previous state loaded</strong></div>
          <div class="filmLine warn"><b>00:12</b><strong>delta / pool price moved beyond threshold</strong></div>
          <div class="filmLine"><b>00:16</b><strong>reason / before -> after stored beside signal</strong></div>
          <div class="filmLine"><b>00:20</b><strong>next sweep / memory compounds</strong></div>
        </div>
      </div>
      <div class="filmProgress"><i></i></div>
    </div>
  </div>
</section>

<main class="wrap">
<section id="desk">
  <div class="top"><div><div class="brand">Canary v0.4 live desk</div><div class="sub">Pons V2 / Robinhood Chain 4663 / persistent read-only watchtower</div></div><span class="pill">READ ONLY</span><div class="spacer"></div><div id="heartbeat" class="heartbeat">loading local state...</div></div>

  <div class="stats">
    <div class="card"><div id="tracked" class="num">0</div><div class="label">tracked positions</div></div>
    <div class="card"><div id="active" class="num">0</div><div class="label">active local watchers</div></div>
    <div class="card"><div id="watch" class="num">0</div><div class="label">WATCH signals / 24h</div></div>
    <div class="card"><div id="leave" class="num">0</div><div class="label">LEAVE signals / 24h</div></div>
    <div class="card"><div id="samples" class="num">0</div><div class="label">remembered snapshots</div></div>
    <div class="card"><div id="rpcBlock" class="num">-</div><div class="label">Robinhood Chain block</div></div>
  </div>


  <div class="pulseBand" id="pulseBand">
    <div class="pulseIntro"><b>the pulse</b><p>Only values Canary can actually read or remember. No manufactured score and no market promises.</p></div>
    <div class="pulseMetric"><span>rpc</span><strong id="pulseRpc" class="live">probing</strong></div>
    <div class="pulseMetric"><span>chain block</span><strong id="pulseBlock">-</strong></div>
    <div class="pulseMetric"><span>snapshots</span><strong id="pulseSamples">0</strong></div>
    <div class="pulseMetric"><span>remembered</span><strong id="pulseTracked">0</strong></div>
  </div>

  <div class="layout">
    <section class="panel">
      <h2>positions remembered by Canary</h2>
      <div class="watchbar"><input id="watchToken" autocomplete="off" spellcheck="false" placeholder="paste a Pons V2 token address"><button id="watchBtn" class="watchbtn">WATCH TOKEN</button><button id="controlBtn" class="tab adminControl" type="button">CONTROL KEY</button></div>
      <div id="watchMsg" class="watchmsg">Starts a local read-only watcher. No signer. No transaction path.</div>
      <div id="watcherRail" class="watcherRail"></div>
      <div class="tools"><input id="search" placeholder="search symbol / token / deployer"><div class="tabs"><button class="tab on" data-filter="ALL">all</button><button class="tab" data-filter="WATCH">watch</button><button class="tab" data-filter="LEAVE">leave</button></div></div>
      <div class="scroll"><table><thead><tr><th>token</th><th>phase</th><th>dev</th><th>market state</th><th>status</th><th>seen</th></tr></thead><tbody id="rows"></tbody></table><div id="empty" class="empty" hidden>Nothing is remembered yet.<br>Paste a Pons V2 token above and start a watcher.</div></div>
    </section>

    <aside class="panel"><h2>position memory</h2><div id="detail" class="detail"><div class="empty">select a token</div></div></aside>
  </div>
</section>


<section class="changed" id="changed">
  <div class="storyHead">
    <div><div class="kicker">02 / what changed</div><h2 class="storyTitle">the useful part is the delta.</h2></div>
    <p class="storyLead">A single chart tells you what exists now. Canary is built around the comparison: what moved, by how much, and which plain rule noticed it.</p>
  </div>
  <div class="changedGrid">
    <div class="stateCard">
      <div class="stateCardHead"><b>previous sweep</b><span>illustrative sequence</span></div>
      <div class="stateRows">
        <div class="stateRow"><span>phase</span><strong>POOL</strong></div>
        <div class="stateRow"><span>deployer share</span><strong>4.80%</strong></div>
        <div class="stateRow"><span>pool price</span><strong>0.000124</strong></div>
        <div class="stateRow"><span>recent swaps</span><strong>14</strong></div>
        <div class="stateRow"><span>token fees</span><strong>0.00</strong></div>
      </div>
    </div>
    <div class="changeArrow">→</div>
    <div class="stateCard">
      <div class="stateCardHead"><b>current sweep</b><span>same fields</span></div>
      <div class="stateRows">
        <div class="stateRow"><span>phase</span><strong>POOL</strong></div>
        <div class="stateRow"><span>deployer share</span><strong>4.80%</strong></div>
        <div class="stateRow changedVal"><span>pool price</span><strong>0.000091</strong></div>
        <div class="stateRow changedVal"><span>recent swaps</span><strong>37</strong></div>
        <div class="stateRow changedVal"><span>token fees</span><strong>12.40</strong></div>
      </div>
    </div>
  </div>
  <div class="changedCallout"><b>why this matters:</b> the example is deliberately labeled illustrative. On a real watched position Canary fills this surface from stored sweeps and keeps the before → after values beside the rule that fired.</div>
</section>

<section class="story" id="how">
  <div class="storyHead"><div><div class="kicker">03 / workflow</div><h2 class="storyTitle">one token becomes a state timeline</h2></div><p class="storyLead">Canary never trades. It reads the chain, saves a snapshot, compares it with the previous state, explains any deterministic delta, and keeps the result for the next sweep.</p></div>
  <div class="flow">
    <div class="flowStep"><div class="flowNo">01</div><h3>paste CA</h3><p>Start a local watcher directly from the board.</p></div>
    <div class="flowStep"><div class="flowNo">02</div><h3>read chain</h3><p>Read deployer, phase, reserve or pool state, swaps, fees and activity.</p></div>
    <div class="flowStep"><div class="flowNo">03</div><h3>snapshot</h3><p>Persist the current state locally for a real before-and-after baseline.</p></div>
    <div class="flowStep"><div class="flowNo">04</div><h3>compare</h3><p>Run transparent thresholds over the previous and current snapshots.</p></div>
    <div class="flowStep"><div class="flowNo">05</div><h3>remember</h3><p>Build live charts and a signal timeline that survives browser refreshes.</p></div>
  </div>
</section>

<section class="story">
  <div class="storyHead"><div><div class="kicker">04 / coverage</div><h2 class="storyTitle">what the desk actually tracks</h2></div><p class="storyLead">Each token is a stateful position with deployer context, market activity, fee movement and Pons V2 phase information attached to it.</p></div>
  <div class="coverage">
    <div class="coverCard"><div class="coverIcon">D</div><h3>deployer share</h3><p>Tracks deployer balance across sweeps and records material drops.</p></div>
    <div class="coverCard"><div class="coverIcon">L</div><h3>reserve and liquidity</h3><p>Reads curve quote reserve before graduation and pool state after graduation.</p></div>
    <div class="coverCard"><div class="coverIcon">A</div><h3>swaps and activity</h3><p>Tracks recent curve trades or pool swaps and the latest known activity.</p></div>
    <div class="coverCard"><div class="coverIcon">F</div><h3>fee movement</h3><p>Shows quote-side and token-side fee state between snapshots.</p></div>
    <div class="coverCard"><div class="coverIcon">P</div><h3>phase changes</h3><p>Follows curve, swept, pool and rescued routing state.</p></div>
    <div class="coverCard"><div class="coverIcon">#</div><h3>deployer history</h3><p>Surfaces recent launch count and graduation context for the deployer.</p></div>
  </div>
</section>

<section class="story" id="signals">
  <div class="storyHead"><div><div class="kicker">05 / deterministic signals</div><h2 class="storyTitle">three states, with the reason beside them</h2></div><p class="storyLead">There is no hidden score. The board keeps the final surface small and every signal points back to a plain rule.</p></div>
  <div class="signalBand">
    <div class="signalCard"><div class="signalName QUIET">QUIET</div><p>No configured threshold crossed on the latest comparison. State is still recorded and memory keeps growing.</p></div>
    <div class="signalCard"><div class="signalName WATCH">WATCH</div><p>A deterministic condition deserves inspection, such as stale activity, fee movement or a serial deployer threshold.</p></div>
    <div class="signalCard"><div class="signalName LEAVE">LEAVE</div><p>The highest-severity local signal, such as a sharp deployer-balance or curve-reserve drop. It is still not an automatic trade.</p></div>
  </div>
</section>

<section class="story" id="memory">
  <div class="storyHead"><div><div class="kicker">06 / persistent memory</div><h2 class="storyTitle">the chart remembers the previous state</h2></div><p class="storyLead">A fresh chart tells you what exists now. Canary is built around what changed one sweep ago, then keeps stacking those observations into live history.</p></div>
  <div class="memoryWrap">
    <div class="memoryViz">
      <div class="memoryNode"><i></i><div><b>sweep arrives</b><span>live on-chain state becomes a normalized snapshot</span></div></div>
      <div class="memoryNode"><i></i><div><b>previous state loads</b><span>the last remembered snapshot becomes the baseline</span></div></div>
      <div class="memoryNode"><i></i><div><b>delta is evaluated</b><span>plain rules produce QUIET / WATCH / LEAVE context</span></div></div>
      <div class="memoryNode"><i></i><div><b>timeline persists</b><span>history and signal context remain available for the next session</span></div></div>
    </div>
    <div class="memoryCopy"><h3>local state by design</h3><p>The board is a view over data the watcher already collected. Closing the browser does not erase the previous state.</p><div class="memoryCode"><strong>.canary/snapshots.json</strong> = latest state<br><strong>.canary/board-memory.json</strong> = historical samples + alerts<br><strong>board refresh 2s</strong> = visualization<br><strong>watch sweep 10s</strong> = fresh chain read</div></div>
  </div>
</section>

<section class="story">
  <div class="storyHead"><div><div class="kicker">07 / trust boundary</div><h2 class="storyTitle">useful because it cannot spend</h2></div><p class="storyLead">The read-only boundary is part of the product. Canary observes and explains state while execution remains somewhere else.</p></div>
  <div class="safety"><div class="safetyBig"><h3>no transaction path.</h3><p>No wallet client, no imported account, no private key flow and no automatic exit hiding behind the dashboard. WATCH TOKEN only starts another read-only process.</p></div><div class="safetyList"><div class="safetyItem"><b>NO SIGNER</b><span>public client reads only</span></div><div class="safetyItem"><b>NO KEY</b><span>signing material is refused</span></div><div class="safetyItem"><b>NO BUY BUTTON</b><span>signals are context, not orders</span></div><div class="safetyItem"><b>PLAIN RULES</b><span>thresholds live in source</span></div></div></div>
</section>


<section class="story" id="refusals">
  <div class="storyHead">
    <div><div class="kicker">08 / refusals</div><h2 class="storyTitle">what Canary refuses to become.</h2></div>
    <p class="storyLead">The boundary is visible on purpose. If a feature needs a signer, a private key, or a guessed number, it does not belong in this watchtower.</p>
  </div>
  <div class="refusals">
    <div class="refusalLead">useful because some paths simply do not exist.</div>
    <div class="refusalList">
      <div class="refusalRow"><code>sign transaction</code><span>refused — Canary has no signer and no execution path.</span></div>
      <div class="refusalRow"><code>import private key</code><span>refused — there is nowhere in the product to store signing material.</span></div>
      <div class="refusalRow"><code>invent a signal</code><span>refused — a WATCH or LEAVE state must map to a configured deterministic rule.</span></div>
      <div class="refusalRow"><code>judge one snapshot</code><span>refused — change signals need a remembered previous state, not a story around one number.</span></div>
    </div>
  </div>
</section>

<div class="footer"><b>Canary v0.4</b><span><span class="footerDomain">usecanary.watch</span> / Robinhood Chain / Pons V2 / read-only watchtower / created by <span id="footerCreator">@gippp69</span></span></div>
</main>

<script>
(function(){
var state=null,selected=null,filter='ALL',pendingToken=null;

function esc(v){return String(v==null?'-':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function age(ms){if(!ms)return 'unknown';var d=Math.max(0,Date.now()-ms);if(d<1000)return 'now';if(d<60000)return Math.floor(d/1000)+'s';if(d<3600000)return Math.floor(d/60000)+'m';return Math.floor(d/3600000)+'h'}
function short(a){if(!a)return '-';return a.length>13?a.slice(0,7)+'...'+a.slice(-4):a}
function clock(ms){if(!ms)return '-';try{return new Date(ms).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch(e){return '-'}}
function fmtNum(v){if(v==null||!isFinite(v))return '-';var n=Math.abs(v);if(n>=1000000)return (v/1000000).toFixed(2)+'m';if(n>=1000)return (v/1000).toFixed(2)+'k';if(n>=1)return v.toFixed(3);if(n>=0.000001)return v.toFixed(8);return v.toExponential(3)}


function scanCell(label,value){return '<div class="scanCell"><b>'+esc(label)+'</b><span title="'+esc(value)+'">'+esc(value)+'</span></div>'}

function renderPublicScan(p){
  var market=p.phase==='POOL'?p.price:p.reserve;
  var html='<div class="scanResultHead"><div><div class="kicker">live on-chain snapshot</div><h3>'+esc(p.symbol)+'</h3><div class="addr">'+esc(p.token)+'</div></div><span class="scanTag">READ ONLY</span></div>'+
    '<div class="scanGrid">'+
      scanCell('phase',p.phase)+
      scanCell('deployer share',Number(p.dev).toFixed(2)+'%')+
      scanCell('market state',market)+
      scanCell('recent activity',String(p.trades))+
      scanCell('deployer launches',String(p.deployerLaunches))+
      scanCell('last activity',age(p.lastTradeAt)+' ago')+
    '</div>'+
    '<div class="scanFoot">One current snapshot, not a change verdict. Persistent QUIET / WATCH / LEAVE needs a previous state to compare against.</div>';

  var box=document.getElementById('publicScanResult');
  box.innerHTML=html;
  box.classList.add('on')
}

async function runPublicScan(){
  var input=document.getElementById('publicScanToken');
  var btn=document.getElementById('publicScanBtn');
  var msg=document.getElementById('publicScanMsg');
  var token=input.value.trim();

  if(!/^0x[a-fA-F0-9]{40}$/.test(token)){
    msg.className='scanMsg err';
    msg.textContent='Paste a valid 0x token address.';
    return
  }

  btn.disabled=true;
  msg.className='scanMsg';
  msg.textContent='Reading Robinhood Chain...';

  try{
    var r=await fetch('/api/scan?token='+encodeURIComponent(token),{cache:'no-store'});
    var data=await r.json();

    if(!r.ok||!data.ok){
      msg.className='scanMsg err';
      msg.textContent=data.error||'Could not read this token.';
      return
    }

    renderPublicScan(data.snapshot);
    msg.className='scanMsg ok';
    msg.textContent=data.cached?'Snapshot returned from the short safety cache.':'Live snapshot read from the chain.';

    try{history.replaceState(null,'','?token='+encodeURIComponent(token)+'#overview')}catch(e){}
  }catch(e){
    msg.className='scanMsg err';
    msg.textContent='Public scanner is temporarily unavailable.'
  }finally{
    btn.disabled=false
  }
}

function initMotion(){
  var glow=document.getElementById('cursorGlow');

  if(glow){
    window.addEventListener('pointermove',function(e){
      glow.style.transform='translate('+(e.clientX-210)+'px,'+(e.clientY-210)+'px)'
    },{passive:true})
  }

  var nodes=document.querySelectorAll('.story,.panel,.card,.heroMetaCard');

  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(x){
        if(x.isIntersecting){
          x.target.classList.add('in');
          io.unobserve(x.target)
        }
      })
    },{threshold:.08});

    Array.prototype.forEach.call(nodes,function(n){
      n.classList.add('reveal');
      io.observe(n)
    })
  }
}


var filmTimer=null,filmStartedAt=0,filmPausedAt=0,filmPaused=false;

function initPublicHost(){
  var h=location.hostname;
  if(h!=='127.0.0.1'&&h!=='localhost'&&h!=='::1')document.body.classList.add('publicHost')
}

function filmFrame(){
  if(filmPaused)return;
  var elapsed=((Date.now()-filmStartedAt)%20000);
  var second=Math.floor(elapsed/1000);
  var stage=Math.min(5,Math.floor(elapsed/4000));
  var lines=document.querySelectorAll('#filmTerminal .filmLine');
  Array.prototype.forEach.call(lines,function(line,i){line.classList.toggle('on',i<=stage)});
  var beats=[
    ['read the chain.<br><em>save the state.</em>','Canary starts with one current snapshot. No signer, no wallet prompt, no transaction path.'],
    ['same fields.<br><em>next sweep.</em>','The next read is normalized into the same shape so the comparison is mechanical, not interpretive.'],
    ['memory loads.<br><em>before meets after.</em>','The previous state becomes the baseline. Nothing useful is lost when the browser refreshes.'],
    ['a threshold moves.<br><em>the reason stays.</em>','A configured condition crosses its line. The signal carries the exact before and after values.'],
    ['one event.<br><em>inside a timeline.</em>','The board keeps the change beside the history that produced it instead of turning it into a mystery score.'],
    ['then it waits.<br><em>and reads again.</em>','No trade is placed. Canary returns to observation and lets the next sweep add another piece of memory.']
  ];
  var beat=document.getElementById('filmBeat'),sub=document.getElementById('filmSub'),clock=document.getElementById('filmClock');
  if(beat)beat.innerHTML=beats[stage][0];
  if(sub)sub.textContent=beats[stage][1];
  if(clock)clock.textContent='00:'+String(second).padStart(2,'0')+' / 00:20';
}

function initFilm(){
  var film=document.getElementById('film'),btn=document.getElementById('filmPause');
  if(!film||!btn)return;
  filmStartedAt=Date.now();
  filmTimer=setInterval(filmFrame,250);
  filmFrame();
  btn.addEventListener('click',function(){
    if(!filmPaused){
      filmPaused=true;filmPausedAt=Date.now();film.classList.remove('playing');btn.textContent='click to play'
    }else{
      filmStartedAt+=Date.now()-filmPausedAt;filmPaused=false;film.classList.add('playing');btn.textContent='click to pause';filmFrame()
    }
  })
}

function renderPulse(){
  if(!state)return;
  var rpc=document.getElementById('pulseRpc'),block=document.getElementById('pulseBlock'),samples=document.getElementById('pulseSamples'),tracked=document.getElementById('pulseTracked');
  if(rpc)rpc.textContent=state.rpc&&state.rpc.status==='ok'?'live':'offline';
  if(block)block.textContent=state.rpc&&state.rpc.block?Number(state.rpc.block).toLocaleString():'-';
  if(samples)samples.textContent=String(state.stats.samples);
  if(tracked)tracked.textContent=String(state.stats.tracked)
}

function renderStats(){
  document.getElementById('tracked').textContent=state.stats.tracked;
  document.getElementById('active').textContent=state.stats.activeWatchers;
  document.getElementById('watch').textContent=state.stats.watch;
  document.getElementById('leave').textContent=state.stats.leave;
  document.getElementById('samples').textContent=state.stats.samples;
  document.getElementById('rpcBlock').textContent=state.rpc&&state.rpc.block?Number(state.rpc.block).toLocaleString():'-';
  if(state.creatorX){var c=String(state.creatorX).replace(/^@/,'');var link=document.getElementById('creatorLink');if(link){link.textContent='@'+c+' on X';link.href='https://x.com/'+encodeURIComponent(c)}var foot=document.getElementById('footerCreator');if(foot)foot.textContent='@'+c}
  var rpc=state.rpc&&state.rpc.status==='ok'?'RPC LIVE':(state.rpc&&state.rpc.status==='error'?'RPC ERROR':'RPC PROBING');
  var fresh=state.writerUpdatedAt?age(state.writerUpdatedAt):'no snapshot';
  document.getElementById('heartbeat').textContent=rpc+' / last snapshot '+fresh+' ago / active '+state.stats.activeWatchers+' / refresh 2s';
}
function filtered(){
  var q=document.getElementById('search').value.toLowerCase();
  return state.positions.filter(function(p){
    var ok=filter==='ALL'||p.status===filter;
    var text=(p.symbol+' '+p.token+' '+p.deployer).toLowerCase();
    return ok&&(!q||text.indexOf(q)>=0)
  })
}

function renderRows(){
  var rows=document.getElementById('rows'),list=filtered();
  document.getElementById('empty').hidden=list.length>0;
  rows.innerHTML=list.map(function(p){
    var pct=Math.max(0,Math.min(100,p.dev));
    var watcher=state.watchers&&state.watchers.find(function(w){return w.token.toLowerCase()===p.token.toLowerCase()});
    var live=watcher?'<span class="rowLive"><i></i>'+esc(watcher.status.toUpperCase())+'</span>':'';
    return '<tr data-token="'+esc(p.token)+'" class="'+(selected===p.token?'sel':'')+'"><td><span class="sym">'+esc(p.symbol)+'</span>'+live+'<br><span class="addr">'+esc(short(p.token))+'</span></td><td class="phase">'+esc(p.phase)+'</td><td>'+p.dev.toFixed(2)+'% <span class="bar"><i style="width:'+pct+'%"></i></span></td><td>'+esc(p.phase==='POOL'?p.price:p.reserve)+'</td><td><span class="badge '+esc(p.status)+'">'+esc(p.status)+'</span></td><td>'+age(p.at)+'</td></tr>'
  }).join('');
  Array.prototype.forEach.call(rows.querySelectorAll('tr'),function(tr){tr.addEventListener('click',function(){selected=tr.getAttribute('data-token');renderRows();renderDetail()})});
  if(!selected&&list[0]){selected=list[0].token;renderRows();renderDetail()}
}
function numericRows(history,key){
  return (history||[]).map(function(x){return {at:x.at,v:x[key]}}).filter(function(x){return typeof x.v==='number'&&isFinite(x.v)})
}

function chartSvg(history,key){
  var rows=numericRows(history,key);
  if(rows.length<2)return '<div class="spark" style="display:flex;align-items:center;justify-content:center;color:var(--muted)">waiting for at least 2 live sweeps</div>';
  var w=520,h=86,px=8,py=8,vals=rows.map(function(x){return x.v}),min=Math.min.apply(null,vals),max=Math.max.apply(null,vals);
  if(max===min){var pad=Math.abs(max||1)*0.02||1;min-=pad;max+=pad}
  var points=rows.map(function(row,i){var x=px+(i*(w-2*px)/Math.max(1,rows.length-1)),y=h-py-((row.v-min)/(max-min))*(h-2*py);return {x:x,y:y}});
  var line=points.map(function(p){return p.x.toFixed(1)+','+p.y.toFixed(1)}).join(' ');
  var area=px+','+(h-py)+' '+line+' '+(w-px)+','+(h-py);
  var tail=points.slice(-60),dots=tail.map(function(p,i){var last=i===tail.length-1;return '<circle class="'+(last?'livePoint':'point')+'" cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="'+(last?'3.4':'1.4')+'"></circle>'}).join('');
  return '<svg class="spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><line class="chartGrid" x1="8" y1="22" x2="512" y2="22"></line><line class="chartGrid" x1="8" y1="43" x2="512" y2="43"></line><line class="chartGrid" x1="8" y1="64" x2="512" y2="64"></line><polygon class="chartArea" points="'+area+'"></polygon><polyline class="chartLine" points="'+line+'"></polyline>'+dots+'</svg>'
}
function chartBlock(title,history,key){
  var rows=numericRows(history,key),last=rows.length?rows[rows.length-1]:null,first=rows.length?rows[0]:null;
  return '<div class="chartCard"><div class="chartHead"><span>'+esc(title)+'</span><span class="chartValue">'+esc(last?fmtNum(last.v):'-')+'</span></div>'+chartSvg(history,key)+'<div class="chartTimes"><span>'+esc(first?clock(first.at):'-')+'</span><span class="chartSampleMeta">'+rows.length+' samples / '+(last?age(last.at)+' ago':'waiting')+'</span><span>'+esc(last?clock(last.at):'-')+'</span></div></div>'
}
function renderDetail(){
  var box=document.getElementById('detail'),p=state.positions.find(function(x){return x.token===selected});
  var watcher=state.watchers&&state.watchers.find(function(w){return selected&&w.token.toLowerCase()===selected.toLowerCase()});
  if(!p){
    if(pendingToken&&watcher){box.innerHTML='<div class="pendingBox"><b>FIRST LIVE SWEEP IN PROGRESS</b>Canary is validating this token against Pons V2, reading on-chain state, and will select it automatically when the first snapshot lands.<br><br><span class="addr">'+esc(pendingToken)+'</span></div>'}
    else box.innerHTML='<div class="empty">select a token</div>';
    return
  }
  var h=state.histories[p.token.toLowerCase()]||state.histories[p.token]||[];
  var events=state.alerts.filter(function(a){return a.token.toLowerCase()===p.token.toLowerCase()}).slice(0,12);
  var runtime=state.watchers&&state.watchers.find(function(w){return w.token.toLowerCase()===p.token.toLowerCase()});
  var grad=p.deployerGraduated==null?'-':p.deployerGraduated+'/'+p.deployerLaunches;
  var marketKey=p.phase==='POOL'?'price':'reserve',marketTitle=p.phase==='POOL'?'pool price':'curve reserve';
  var next=runtime&&runtime.nextSweepAt?Math.max(0,Math.ceil((runtime.nextSweepAt-Date.now())/1000))+'s':'-';
  var strip=runtime?'<div class="liveStrip"><div class="liveCell"><b>watcher</b><span><i class="liveDot"></i>'+esc(runtime.status.toUpperCase())+'</span></div><div class="liveCell"><b>sweeps</b><span>'+esc(runtime.sweepCount)+'</span></div><div class="liveCell"><b>last sweep</b><span>'+(runtime.lastSweepAt?age(runtime.lastSweepAt)+' ago':'waiting')+'</span></div><div class="liveCell"><b>next sweep</b><span>'+esc(next)+'</span></div></div>':'';
  var coverage='<div class="memoryTitle">monitoring now</div><div class="monitorGrid"><div class="monitorItem"><b>deployer</b><span>share + launch history</span></div><div class="monitorItem"><b>market</b><span>'+(p.phase==='POOL'?'pool price + liquidity':'curve reserve')+'</span></div><div class="monitorItem"><b>activity</b><span>trades / swaps + last activity</span></div><div class="monitorItem"><b>fees</b><span>quote + token fee state</span></div><div class="monitorItem"><b>phase</b><span>curve / swept / pool / rescued</span></div><div class="monitorItem"><b>memory</b><span>before vs after every sweep</span></div></div>';
  var feed=runtime&&runtime.events&&runtime.events.length?runtime.events.slice(0,10).map(function(e){return '<div class="feedRow"><div class="feedTop"><span class="'+(e.status==='LEAVE'?'LEAVE':e.status==='WATCH'?'WATCH':e.status==='ERROR'?'LEAVE':e.status==='INFO'?'INFO':'QUIET')+'">'+esc(e.status)+' / sweep #'+esc(e.sweep)+'</span><span class="feedMeta">'+esc((e.durationMs/1000).toFixed(1))+'s / '+age(e.at)+' ago</span></div><div class="feedChanges">'+esc(e.message)+(e.changes&&e.changes.length?' / '+esc(e.changes.join(' / ')):'')+'</div></div>'}).join(''):'<div class="feedRow"><div class="feedChanges">No live sweep events in this board session yet.</div></div>';
  box.innerHTML='<div class="detailHead">'+esc(p.symbol)+'</div><div class="addr">'+esc(p.token)+'</div><div style="margin-top:10px"><span class="badge '+esc(p.status)+'">'+esc(p.status)+'</span> <span class="badge phase">'+esc(p.phase)+'</span></div>'+strip+
    '<div class="grid"><div class="kv"><b>deployer share</b>'+p.dev.toFixed(2)+'%</div><div class="kv"><b>creator tax</b>'+(p.creatorTaxPct==null?'-':p.creatorTaxPct.toFixed(2)+'%')+'</div><div class="kv"><b>price / reserve</b>'+esc(p.phase==='POOL'?p.price:p.reserve)+'</div><div class="kv"><b>recent trades</b>'+esc(p.trades)+'</div><div class="kv"><b>quote fees</b>'+esc(p.quoteFees)+'</div><div class="kv"><b>token fees</b>'+esc(p.tokenFees)+'</div><div class="kv"><b>deployer launches</b>'+esc(p.deployerLaunches)+'</div><div class="kv"><b>graduated</b>'+esc(grad)+'</div><div class="kv"><b>deployer</b>'+esc(short(p.deployer))+'</div><div class="kv"><b>last activity</b>'+age(p.lastTradeAt)+'</div></div>'+coverage+
    '<div class="memoryTitle">live history / '+h.length+' samples</div><div class="charts">'+chartBlock('deployer share %',h,'dev')+chartBlock(marketTitle,h,marketKey)+chartBlock('recent activity',h,'trades')+'</div><div class="memoryTitle">live sweep feed</div><div class="liveFeed">'+feed+'</div><div class="memoryTitle">deterministic signal timeline</div>'+
    (events.length?events.map(function(a){var delta=a.was||a.now?'<div class="eventDelta">'+esc(a.was||'-')+' -> '+esc(a.now||'-')+'</div>':'';return '<div class="event"><span class="'+(a.level==='leave'?'LEAVE':a.level==='warn'?'WATCH':'INFO')+'">'+esc(a.level.toUpperCase())+'</span> '+esc(a.rule)+'<br><small>'+esc(a.headline)+' / '+age(a.at)+' ago</small>'+delta+'</div>'}).join(''):'<div class="event"><small>No remembered signal for this token.</small></div>')
}
function renderWatchers(){
  var rail=document.getElementById('watcherRail'),msg=document.getElementById('watchMsg');
  if(!state.watchers||!state.watchers.length){rail.innerHTML='';return}
  rail.innerHTML=state.watchers.slice(0,8).map(function(w){var cls=w.status==='retrying'?'retrying':'running';return '<div class="watcherChip '+cls+'" title="'+esc(w.lastError||'')+'"><span>'+esc(short(w.token))+'</span><b>'+esc(w.status)+'</b><button class="stopBtn" data-stop="'+esc(w.token)+'" title="stop watcher">x</button></div>'}).join('');
  Array.prototype.forEach.call(rail.querySelectorAll('[data-stop]'),function(b){b.addEventListener('click',function(){stopWatch(b.getAttribute('data-stop'))})});
  if(pendingToken){
    var w=state.watchers.find(function(x){return x.token.toLowerCase()===pendingToken.toLowerCase()});
    var p=state.positions.find(function(x){return x.token.toLowerCase()===pendingToken.toLowerCase()});
    if(w&&p&&p.at>=w.startedAt){selected=p.token;pendingToken=null;filter='ALL';document.getElementById('search').value='';document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('on',x.getAttribute('data-filter')==='ALL')});msg.className='watchmsg ok';msg.textContent='LIVE. First on-chain sweep stored. Canary is monitoring this token every 10 seconds.'}
    else if(w&&w.status==='retrying'&&w.lastError){msg.className='watchmsg err';msg.textContent='Watcher retrying: '+w.lastError}
  }
}
function render(){
  renderStats();
  renderPulse();
  renderWatchers();
  renderRows();
  renderDetail();
}
async function load(){
  try{
    var r=await fetch('/api/state',{cache:'no-store'});
    state=await r.json();
    render()
  }catch(e){
    document.getElementById('heartbeat').textContent='BOARD API UNAVAILABLE'
  }
}

function controlHeaders(){
  var h={'content-type':'application/json'};
  try{var key=localStorage.getItem('canaryControlKey')||'';if(key)h['x-canary-control']=key}catch(e){}
  return h
}
function saveControlKey(){
  var current='';try{current=localStorage.getItem('canaryControlKey')||''}catch(e){}
  var value=window.prompt('Canary control key. Leave blank to clear it.',current);
  if(value===null)return;
  try{if(value)localStorage.setItem('canaryControlKey',value);else localStorage.removeItem('canaryControlKey')}catch(e){}
  var msg=document.getElementById('watchMsg');msg.className='watchmsg ok';msg.textContent=value?'Control key saved in this browser.':'Control key cleared.'
}

async function startWatch(){
  var input=document.getElementById('watchToken'),btn=document.getElementById('watchBtn'),msg=document.getElementById('watchMsg'),token=input.value.trim();
  if(!token){msg.className='watchmsg err';msg.textContent='Paste a token address first.';return}
  if(!/^0x[a-fA-F0-9]{40}$/.test(token)){msg.className='watchmsg err';msg.textContent='That is not a valid EVM token address.';return}
  btn.disabled=true;msg.className='watchmsg';msg.textContent='Starting local read-only watcher...';
  try{
    var r=await fetch('/api/watch',{method:'POST',headers:controlHeaders(),body:JSON.stringify({token:token})});
    var data=await r.json();
    if(!r.ok||!data.ok){
      msg.className='watchmsg err';msg.textContent=data.error||'Failed to start watcher.'
    }else{
      pendingToken=token;
      msg.className='watchmsg ok';
      msg.textContent=data.started?'Watcher started. Validating Pons V2 and reading the first live snapshot...':'This token is already being watched.';
      setTimeout(load,300)
    }
  }catch(e){
    msg.className='watchmsg err';msg.textContent='Local board control is unavailable.'
  }finally{btn.disabled=false}
}

async function stopWatch(token){
  if(!token)return;
  try{
    await fetch('/api/unwatch',{method:'POST',headers:controlHeaders(),body:JSON.stringify({token:token})});
    setTimeout(load,150)
  }catch(e){}
}


document.getElementById('publicScanBtn').addEventListener('click',runPublicScan);
document.getElementById('publicScanToken').addEventListener('keydown',function(e){if(e.key==='Enter')runPublicScan()});

document.getElementById('watchBtn').addEventListener('click',startWatch);
var controlBtn=document.getElementById('controlBtn');if(controlBtn)controlBtn.addEventListener('click',saveControlKey);
document.getElementById('watchToken').addEventListener('keydown',function(e){if(e.key==='Enter')startWatch()});
document.getElementById('search').addEventListener('input',renderRows);
Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
  b.addEventListener('click',function(){
    filter=b.getAttribute('data-filter');
    document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('on',x===b)});
    renderRows()
  })
});

initPublicHost();
initFilm();
initMotion();
try{
  var initialToken=new URLSearchParams(location.search).get('token');
  if(initialToken&&/^0x[a-fA-F0-9]{40}$/.test(initialToken)){
    document.getElementById('publicScanToken').value=initialToken;
    setTimeout(runPublicScan,120)
  }
}catch(e){}

load();
setInterval(load,2000);
})();
</script>
</body>
</html>`;

sanitizeLocalState();
sampleMemory();
void probeRpc();

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && path === "/api/state") return json(res, 200, apiState());


  if (req.method === "GET" && path === "/api/scan") {
    const url = new URL(req.url ?? "/", "http://canary.local");
    const token = (url.searchParams.get("token") ?? "").trim();

    if (!isAddress(token)) {
      return json(res, 400, { ok: false, error: "not a valid EVM token address" });
    }

    const budget = takePublicScanBudget(req);
    if (!budget.ok) {
      res.setHeader("retry-after", String(budget.retryAfterSeconds));
      return json(res, 429, {
        ok: false,
        error: "public scan limit reached; retry in " + budget.retryAfterSeconds + "s",
      });
    }

    try {
      const result = await scanPublicToken(token);
      return json(res, 200, {
        ok: true,
        snapshot: result.snapshot,
        cached: result.cached,
        remaining: budget.remaining,
      });
    } catch {
      return json(res, 502, {
        ok: false,
        error: "Canary could not read this token as a live Pons V2 position.",
      });
    }
  }

  if (req.method === "POST" && path === "/api/watch") {
    if (!requestControlAllowed(req)) {
      return json(res, 403, { ok: false, error: "watcher control is locked; direct localhost or a valid control key is required" });
    }
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || "{}") as { token?: unknown };
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      const result = startWatcher(token);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.method === "POST" && path === "/api/unwatch") {
    if (!requestControlAllowed(req)) {
      return json(res, 403, { ok: false, error: "watcher control is locked; direct localhost or a valid control key is required" });
    }
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || "{}") as { token?: unknown };
      const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
      const result = stopWatcher(token);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return void res.end(PAGE);
  }

  text(res, 404, "not found");
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`\nCanary v0.4 board  ${url}`);
  console.log(`RPC               ${CONFIG.rpcUrl}`);
  console.log(`memory            ${MEMORY_FILE}`);
  console.log(`watchlist         ${WATCHLIST_FILE}`);
  console.log(`control           ${CONTROL_TOKEN ? "key protected" : "direct localhost only"}`);
  console.log("read only         no signer, no key, no transaction path\n");

  for (const token of readWatchlist()) startWatcher(token, false);

  if (hasArg("--open")) {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
});

server.on("error", (err) => {
  console.error(`board failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

function stopAllWatchers(): void {
  for (const runtime of watchers.values()) {
    if (runtime.timer) clearTimeout(runtime.timer);
  }
}

process.once("SIGINT", () => {
  stopAllWatchers();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopAllWatchers();
  process.exit(0);
});

setInterval(sampleMemory, 2_000).unref();
setInterval(() => void probeRpc(), 15_000).unref();
