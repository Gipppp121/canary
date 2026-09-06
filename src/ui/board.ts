import type { Alert, Snapshot } from "../watch/signals.js";
import * as readline from "node:readline";
import { ago, bar, short, units } from "../util/fmt.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  lime: "\x1b[38;5;154m",
  limeBg: "\x1b[48;5;154m\x1b[30m",
};

const PHASE = ["CURVE", "SWEPT", "POOL", "RESCUED"];

export interface BoardMeta {
  elapsedMs: number;
  checked: number;
  pollSeconds: number;
  demo?: boolean;
  rpcLabel?: string;
}

function colour(text: string, code: string): string {
  if (process.env.NO_COLOR) return text;
  return `${code}${text}${C.reset}`;
}

function tagFor(snapshot: Snapshot, alerts: Alert[]): { text: string; code: string } {
  const mine = alerts.filter((a) => a.token.toLowerCase() === snapshot.token.toLowerCase());
  if (mine.some((a) => a.level === "leave")) return { text: "LEAVE", code: C.red };
  if (mine.some((a) => a.level === "warn")) return { text: "WATCH", code: C.yellow };
  if (mine.some((a) => a.level === "info")) return { text: "INFO", code: C.cyan };
  return { text: "QUIET", code: C.green };
}

function alertTag(level: Alert["level"]): string {
  if (level === "leave") return colour(" LEAVE ", C.red + C.bold);
  if (level === "warn") return colour(" WATCH ", C.yellow + C.bold);
  return colour(" INFO  ", C.cyan + C.bold);
}

function hr(width = 112): string {
  return colour("─".repeat(width), C.gray);
}

function logo(): string {
  return colour(
` ██████╗ █████╗ ███╗   ██╗ █████╗ ██████╗ ██╗   ██╗
██╔════╝██╔══██╗████╗  ██║██╔══██╗██╔══██╗╚██╗ ██╔╝
██║     ███████║██╔██╗ ██║███████║██████╔╝ ╚████╔╝
██║     ██╔══██║██║╚██╗██║██╔══██║██╔══██╗  ╚██╔╝
╚██████╗██║  ██║██║ ╚████║██║  ██║██║  ██║   ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝`, C.lime);
}

let exitHookInstalled = false;

function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  // Windows Terminal + npm can leave old frames in scrollback if we only emit ANSI clear.
  // Rewind to 0,0 and erase the visible frame instead, so every refresh occupies one screen.
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write("\x1b[?25l");
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    const showCursor = () => { if (process.stdout.isTTY) process.stdout.write("\x1b[?25h"); };
    process.once("exit", showCursor);
    process.once("SIGINT", () => { showCursor(); process.exit(130); });
  }
}

function fmtReserve(s: Snapshot): string {
  return `${units(s.liquidityWei, s.pairDecimals ?? 18)} ${s.pairSymbol ?? "QUOTE"}`;
}

function fmtFees(s: Snapshot): string {
  return `${units(s.feesPendingWei, s.pairDecimals ?? 18)} ${s.pairSymbol ?? "QUOTE"}`;
}

function compactBigint(v: bigint | undefined): string {
  if (v === undefined) return "unknown";
  const n = Number(v);
  if (!Number.isFinite(n)) return v.toString();
  if (n >= 1e15) return `${(n / 1e15).toFixed(2)}q`;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return v.toString();
}

function fmtPrice(s: Snapshot): string {
  const p = s.poolPriceQuotePerToken;
  if (p === undefined || !Number.isFinite(p) || p <= 0) return "unknown";
  if (p >= 1) return p.toFixed(6);
  if (p >= 0.000001) return p.toFixed(8);
  return p.toExponential(3);
}

export function renderBoard(snapshots: Snapshot[], alerts: Alert[], meta: BoardMeta): void {
  clearScreen();
  const now = new Date();
  const hhmmss = now.toTimeString().slice(0, 8);

  console.log(logo());
  console.log(colour("the read-only watchtower for Pons V2 on Robinhood Chain", C.dim));
  console.log("");
  console.log(
    `${colour("canary watch", C.lime + C.bold)} · pons v2 · Robinhood Chain (4663) · ` +
    `${colour(" READ ONLY ", C.limeBg + C.bold)} · no signer · ${meta.demo ? "fixtures" : (meta.rpcLabel ?? "live RPC")}`
  );
  console.log(`${colour(hhmmss, C.gray)}  checked ${meta.checked} · alerts ${alerts.length} · sweep ${ago(meta.elapsedMs)} · next ${meta.pollSeconds}s`);
  console.log(hr());

  if (!snapshots.length) {
    console.log(`\n${colour("no positions discovered", C.yellow)}  pin a token with --token if wallet discovery misses it\n`);
  }

  for (const s of snapshots) {
    const status = tagFor(s, alerts);
    const phase = s.phase === undefined ? "UNKNOWN" : (PHASE[s.phase] ?? String(s.phase));
    const tokenAlerts = alerts.filter((a) => a.token.toLowerCase() === s.token.toLowerCase());
    const last = s.lastTradeAt > 0 ? `${ago(Date.now() - s.lastTradeAt)} ago` : "unknown";
    const devBar = bar(s.devHoldPct, 18);

    console.log(
      `${colour(hhmmss, C.gray)}  ${colour(s.symbol.padEnd(12).slice(0, 12), C.bold)} ` +
      `${colour(short(s.token).padEnd(13), C.gray)} ${colour(phase.padEnd(7), C.cyan)} ` +
      `${colour(status.text.padEnd(6), status.code + C.bold)}  signals ${tokenAlerts.length}`
    );
    if (s.phase === 2) {
      console.log(
        `  dev ${s.devHoldPct.toFixed(2).padStart(6)}% ${colour(devBar, s.devHoldPct >= 15 ? C.red : C.lime)}  ` +
        `price ${fmtPrice(s)} ${s.pairSymbol ?? "QUOTE"}/token  swaps ${String(s.trades).padStart(4)}  last ${last}`
      );
      console.log(
        `  v4 L ${compactBigint(s.poolLiquidity).padEnd(12)} quote fees ${fmtFees(s).padEnd(16)} ` +
        `token fees ${units(s.poolPendingTokenFeesWei ?? 0n, s.tokenDecimals ?? 18)} ${s.symbol}`
      );
      console.log(
        `  launches ${String(s.deployerLaunches).padStart(4)}  ` +
        `${s.creatorTaxBps !== undefined ? `creator tax ${(s.creatorTaxBps / 100).toFixed(2)}%  ` : ""}` +
        `tick ${s.poolTick ?? "?"}  deployer ${s.deployer ? short(s.deployer) : "unknown"}`
      );
    } else {
      console.log(
        `  dev ${s.devHoldPct.toFixed(2).padStart(6)}% ${colour(devBar, s.devHoldPct >= 15 ? C.red : C.lime)}  ` +
        `reserve ${fmtReserve(s).padEnd(18)} trades ${String(s.trades).padStart(4)}  last ${last}`
      );
      console.log(
        `  fees ${fmtFees(s).padEnd(19)} launches ${String(s.deployerLaunches).padStart(4)}  ` +
        `${s.creatorTaxBps !== undefined ? `creator tax ${(s.creatorTaxBps / 100).toFixed(2)}%  ` : ""}` +
        `deployer ${s.deployer ? short(s.deployer) : "unknown"}`
      );
    }
    if (tokenAlerts.length) {
      for (const a of tokenAlerts.slice(0, 2)) {
        console.log(`  ${alertTag(a.level)} ${a.rule} · ${a.detail}`);
      }
    }
    console.log(colour("  read complete · no transaction path exists", C.dim));
    console.log("");
  }

  console.log(hr());
  if (alerts.length) {
    console.log(colour("latest deterministic signals", C.bold));
    for (const a of alerts.slice(0, 6)) {
      console.log(`${alertTag(a.level)} ${a.symbol.padEnd(12)} ${a.headline}`);
    }
  } else {
    console.log(`${colour("QUIET", C.green + C.bold)}  no rule crossed its threshold on this sweep`);
  }
  console.log(colour("\nctrl+c to stop · state persists in .canary/ · Telegram remains best-effort if configured", C.dim));
}
