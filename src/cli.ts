#!/usr/bin/env node
/** canary — read-only Pons V2 watchtower for Robinhood Chain. */

import { Command } from "commander";
import { loadConfig, loadLocalEnv, isAddress, KeyRefused } from "./util/env.js";
import { Store } from "./watch/store.js";
import { sweep } from "./watch/sweep.js";
import { evaluate, DEFAULT_THRESHOLDS, type Snapshot } from "./watch/signals.js";
import { TerminalSink, TelegramSink, Deduped } from "./alert/sink.js";
import { FixtureReader } from "./chain/reader.js";
import { PonsV2Reader, ROBINHOOD_CHAIN_ID } from "./chain/rpc.js";
import { bar, short, ago, units } from "./util/fmt.js";

const VERSION = "0.2.0";
const PHASE = ["curve", "swept", "pool", "rescued"];

function banner(): void {
  console.log(`\x1b[33m
   ,__,     canary ${VERSION}
   (oo)     the watchtower for Robinhood Chain
  (\\__/)    read only · no key · it cannot spend
\x1b[0m`);
}

function demoReader(): FixtureReader {
  const now = Date.now();
  const base = (over: Partial<Snapshot>): Snapshot => ({
    token: "0x0000000000000000000000000000000000000000",
    symbol: "???",
    devHoldPct: 3,
    liquidityWei: 4_200_000_000_000_000_000n,
    trades: 40,
    lastTradeAt: now,
    feesPendingWei: 300_000_000_000_000_000n,
    deployerLaunches: 2,
    deployerGraduated: 1,
    phase: 0,
    at: now,
    ...over,
  });
  const good = base({ token: "0xaaa1", symbol: "STEADY" });
  const bad = base({
    token: "0xbbb2",
    symbol: "NIGHTS",
    devHoldPct: 18,
    deployerLaunches: 297,
    deployerGraduated: 0,
  });
  return new FixtureReader(
    { "0xaaa1": good, "0xbbb2": bad },
    { "0xdemo": [
      { token: "0xaaa1", symbol: "STEADY", balance: 1n },
      { token: "0xbbb2", symbol: "NIGHTS", balance: 1n },
    ] }
  );
}

function liveReader() {
  const cfg = loadConfig();
  return new PonsV2Reader({
    rpcUrl: cfg.rpcUrl,
    factory: cfg.ponsFactory as `0x${string}`,
    indexLookbackBlocks: cfg.indexLookbackBlocks,
    tradeLookbackBlocks: cfg.tradeLookbackBlocks,
    logChunkBlocks: cfg.logChunkBlocks,
    pinnedTokens: cfg.tokens.filter(isAddress) as `0x${string}`[],
    discoveryMaxTokens: cfg.discoveryMaxTokens,
  });
}

function printSnapshot(s: Snapshot): void {
  const phase = s.phase === undefined ? "unknown" : PHASE[s.phase] ?? String(s.phase);
  console.log(`${s.symbol}  ${s.token}`);
  console.log(`phase        ${phase}`);
  console.log(`deployer     ${s.deployer ? short(s.deployer) : "unknown"}`);
  console.log(`dev balance  ${s.devHoldPct.toFixed(2)}% of supply`);
  if (s.phase === 0 || s.phase === undefined) {
    console.log(`curve reserve ${units(s.liquidityWei, s.pairDecimals ?? 18)} ${s.pairSymbol ?? "quote"}`);
    console.log(`recent trades ${s.trades}`);
    console.log(`last trade    ${s.lastTradeAt ? `${ago(Date.now() - s.lastTradeAt)} ago` : "unknown / RPC did not return logs"}`);
    console.log(`pending fees  ${s.feesPendingWei.toString()} raw quote units`);
  }
  console.log(`dev launches  ${s.deployerLaunches} in indexed window`);
  if (s.creatorTaxBps !== undefined) console.log(`creator tax   ${(s.creatorTaxBps / 100).toFixed(2)}%`);
}

loadLocalEnv();

const program = new Command();
program
  .name("canary")
  .description("Read-only Pons V2 watchtower for Robinhood Chain. No key, no signing code.")
  .version(VERSION);

program
  .command("doctor")
  .description("check config; add --probe to touch the live chain")
  .option("--probe", "verify RPC chain id, block height, and Pons V2 factory bytecode")
  .action(async (opts: { probe?: boolean }) => {
    banner();
    let cfg;
    try {
      cfg = loadConfig();
    } catch (e) {
      if (e instanceof KeyRefused) {
        console.error(`\x1b[31m${e.message}\x1b[0m`);
        process.exitCode = 2;
        return;
      }
      throw e;
    }
    console.log(`rpc          ${cfg.rpcUrl}`);
    console.log(`factory      ${cfg.ponsFactory}`);
    console.log(`wallets      ${cfg.wallets.length ? cfg.wallets.map(short).join(", ") : "none set"}`);
    console.log(`tokens       ${cfg.tokens.length ? cfg.tokens.map(short).join(", ") : "none pinned"}`);
    console.log(`poll         every ${cfg.pollSeconds}s`);
    console.log(`telegram     ${cfg.telegramToken ? "configured" : "off, terminal only"}`);
    console.log(`signing      \x1b[32mnot built in\x1b[0m`);
    console.log(`index        ${cfg.indexLookbackBlocks.toLocaleString()} blocks; logs in ${cfg.logChunkBlocks.toLocaleString()}-block chunks`);
    console.log(`discovery    newest ${cfg.discoveryMaxTokens} launches per wallet pass; pin older tokens with TOKENS`);
    console.log(`\nthresholds`);
    console.log(`  deployer balance falls >     ${cfg.devSellPct} points`);
    console.log(`  curve reserve falls >        ${cfg.liquidityDropPct}%`);
    console.log(`  no curve trade for           ${cfg.volumeDeadMinutes}m`);
    console.log(`  deployer launches >=         ${cfg.serialDeployerCount}`);

    if (opts.probe) {
      console.log("\nprobe");
      const h = await liveReader().health();
      if (!h.ok) {
        console.error(`  \x1b[31mfailed\x1b[0m ${h.error ?? "unknown error"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  chain id     ${h.chainId} ${h.chainId === ROBINHOOD_CHAIN_ID ? "✓" : ""}`);
      console.log(`  block        ${h.block?.toString()}`);
      console.log(`  factory      bytecode present ✓`);
    }
  });

program
  .command("rules")
  .description("print every rule that can wake you")
  .action(() => {
    const rows: Array<[string, string, string]> = [
      ["deployer-balance-drop", "LEAVE", "deployer token balance fell between sweeps"],
      ["curve-reserve-drop", "LEAVE", "real quote reserve fell while still on the curve"],
      ["fees-swept", "WATCH", "pending curve fees moved out of the curve"],
      ["volume-dead", "WATCH", "no indexed curve trade for the configured window"],
      ["serial-deployer", "WATCH", "same deployer has many recent launches"],
      ["phase-change", "INFO", "launch routing moved between curve/swept/pool/rescued"],
    ];
    console.log("");
    for (const [rule, level, what] of rows) {
      const c = level === "LEAVE" ? "\x1b[31m" : level === "WATCH" ? "\x1b[33m" : "\x1b[36m";
      console.log(`${c}${level.padEnd(5)}\x1b[0m  ${rule.padEnd(24)} ${what}`);
    }
    console.log("\nEvery rule is deterministic in src/watch/signals.ts.\n");
  });

program
  .command("watch [wallets...]")
  .description("watch recent Pons V2 positions held by wallets, or pin tokens directly")
  .option("--once", "sweep once and exit")
  .option("--demo", "fixtures only, no network")
  .option("--token <addresses...>", "watch token addresses directly, even if wallet discovery misses them")
  .action(async (wallets: string[], opts: { once?: boolean; demo?: boolean; token?: string[] }) => {
    banner();
    const cfg = loadConfig();
    const list = wallets.length ? wallets : cfg.wallets;
    const direct = [...(cfg.tokens ?? []), ...(opts.token ?? [])];

    if (!opts.demo && list.length === 0 && direct.length === 0) {
      console.error("nothing to watch. pass a wallet, use --token, or set WALLETS/TOKENS in .env");
      console.error("or try:  npm run canary -- watch --demo");
      process.exitCode = 2;
      return;
    }
    for (const w of [...list, ...direct]) {
      if (!opts.demo && !isAddress(w)) {
        console.error(`not an address: ${w}`);
        process.exitCode = 2;
        return;
      }
    }

    const reader = opts.demo ? demoReader() : liveReader();
    const store = new Store();
    const sinks = [new TerminalSink()];
    if (cfg.telegramToken) sinks.push(new TelegramSink(cfg.telegramToken, cfg.telegramChatId));
    const sink = new Deduped(sinks);
    const watched = opts.demo ? ["0xdemo"] : list;

    const run = async () => {
      const t0 = Date.now();
      const res = await sweep(reader, store, sink, watched, {
        devSellPct: cfg.devSellPct,
        liquidityDropPct: cfg.liquidityDropPct,
        volumeDeadMinutes: cfg.volumeDeadMinutes,
        serialDeployerCount: cfg.serialDeployerCount,
      }, Date.now(), opts.demo ? [] : direct);
      const quiet = res.alerts.length === 0 ? "  \x1b[2mquiet\x1b[0m" : "";
      console.log(`\x1b[2m${new Date().toISOString().slice(11, 19)}  swept ${res.checked} position(s) in ${ago(Date.now() - t0)}\x1b[0m${quiet}`);
    };

    await run();
    if (opts.demo && reader instanceof FixtureReader) {
      reader.advance("0xbbb2", { devHoldPct: 9, liquidityWei: 2_900_000_000_000_000_000n });
      console.log("\x1b[2m…time passes…\x1b[0m\n");
      await run();
    }
    if (opts.once || opts.demo) return;

    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      try { await run(); }
      catch (e) { console.error(`sweep failed: ${e instanceof Error ? e.message : String(e)}`); }
      finally { running = false; }
    }, cfg.pollSeconds * 1000);
  });

program
  .command("scan <token>")
  .description("read one live Pons V2 launch without saving state")
  .action(async (token: string) => {
    if (!isAddress(token)) {
      console.error(`not an address: ${token}`);
      process.exitCode = 2;
      return;
    }
    banner();
    try {
      const s = await liveReader().snapshot(token);
      printSnapshot(s);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

program
  .command("check")
  .description("run the deployer-balance rule on two numbers, no chain needed")
  .requiredOption("--dev-was <pct>", "deployer share before", parseFloat)
  .requiredOption("--dev-now <pct>", "deployer share now", parseFloat)
  .option("--symbol <s>", "label", "TOKEN")
  .action((o: { devWas: number; devNow: number; symbol: string }) => {
    const now = Date.now();
    const mk = (devHoldPct: number): Snapshot => ({
      token: "0xcheck", symbol: o.symbol, devHoldPct,
      liquidityWei: 1n, trades: 1, lastTradeAt: now,
      feesPendingWei: 0n, deployerLaunches: 1, phase: 0, at: now,
    });
    const alerts = evaluate(mk(o.devWas), mk(o.devNow), DEFAULT_THRESHOLDS, now);
    if (!alerts.length) return void console.log("nothing fires on those numbers.");
    const sink = new TerminalSink();
    for (const a of alerts) sink.send(a);
  });

program
  .command("positions")
  .description("snapshots canary remembers locally")
  .action(() => {
    const all = new Store().all();
    if (!all.length) return void console.log("nothing seen yet. run `npm run canary -- watch --demo` first.");
    for (const s of all) {
      const phase = s.phase === undefined ? "?" : PHASE[s.phase] ?? String(s.phase);
      console.log(`${s.symbol.padEnd(10)} ${phase.padEnd(7)} dev ${String(s.devHoldPct.toFixed(1)).padStart(5)}%  ${bar(100 - s.devHoldPct, 16)}  seen ${ago(Date.now() - s.at)} ago`);
    }
  });

export function main(argv: string[] = process.argv): void {
  program.parse(argv);
}

main();
