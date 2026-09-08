import type { Alert, Snapshot } from "../watch/signals.js";
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

interface BoardState {
  snapshots: Snapshot[];
  alerts: Alert[];
  meta: BoardMeta;
}

let latestState: BoardState | undefined;
let animationTimer: ReturnType<typeof setInterval> | undefined;
let animationTick = 0;
let terminalModeEntered = false;
let exitHookInstalled = false;

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

function hr(width = 104): string {
  return colour("─".repeat(width), C.gray);
}

function centerLine(text: string): string {
  const width = Math.max(80, process.stdout.columns ?? 112);
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  return " ".repeat(pad) + text;
}

function logo(): string {
  const lines = [
    " ██████  █████  █   █  █████  ████   █   █ ",
    " █       █   █  ██  █  █   █  █   █   █ █  ",
    " █       █████  █ █ █  █████  ████     █   ",
    " █       █   █  █  ██  █   █  █  █     █   ",
    " ██████  █   █  █   █  █   █  █   █    █   ",
  ];
  return lines.map((line) => centerLine(colour(line, C.lime + C.bold))).join("\n");
}

function enterTerminalMode(): void {
  if (!process.stdout.isTTY || terminalModeEntered) return;
  terminalModeEntered = true;

  // Use the alternate screen buffer so animation never floods normal terminal scrollback.
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");

  if (!exitHookInstalled) {
    exitHookInstalled = true;

    const restoreTerminal = () => {
      if (!process.stdout.isTTY) return;
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    };

    process.once("exit", restoreTerminal);
    process.once("SIGINT", () => {
      restoreTerminal();
      process.exit(130);
    });
    process.once("SIGTERM", () => {
      restoreTerminal();
      process.exit(143);
    });
  }
}

function clearScreen(): void {
  if (!process.stdout.isTTY) return;
  enterTerminalMode();

  // Reuse exactly one visible frame. Nothing is appended to scrollback.
  process.stdout.write("\x1b[H\x1b[2J");
}

function mascotStatus(alerts: Alert[]): { label: string; code: string } {
  if (alerts.some((a) => a.level === "leave")) {
    return { label: "CANARY ALERT", code: C.red };
  }
  if (alerts.some((a) => a.level === "warn")) {
    return { label: "CANARY WATCH", code: C.yellow };
  }
  return { label: "CANARY PATROL", code: C.lime };
}

const RIGHT_BIRD = [
  [
    "   ▄▄       ",
    " ▄████▄     ",
    "██ ● ██▄▄>  ",
    " ▀████▀     ",
    "  ▀  ▀      ",
  ],
  [
    "   ▄▄       ",
    " ▄████▄     ",
    "██ ● ████>  ",
    "  ████▀     ",
    " ▄▀  ▀      ",
  ],
  [
    "   ▄▄       ",
    " ▄████▄     ",
    "██ ● ██▄▄>  ",
    " ▄████▀     ",
    "▀  ▀        ",
  ],
] as const;

const LEFT_BIRD = [
  [
    "       ▄▄   ",
    "     ▄████▄ ",
    "  <▄▄██ ● ██",
    "     ▀████▀ ",
    "      ▀  ▀  ",
  ],
  [
    "       ▄▄   ",
    "     ▄████▄ ",
    "  <████ ● ██",
    "     ▀████  ",
    "      ▀  ▀▄ ",
  ],
  [
    "       ▄▄   ",
    "     ▄████▄ ",
    "  <▄▄██ ● ██",
    "     ▀████▄ ",
    "        ▀  ▀",
  ],
] as const;

function pixelCanary(alerts: Alert[]): string {
  const terminalWidth = Math.max(90, Math.min(process.stdout.columns ?? 112, 160));
  const spriteWidth = 13;
  const statusWidth = 22;
  const laneWidth = Math.max(36, terminalWidth - spriteWidth - statusWidth - 8);

  const raw = (animationTick * 2) % (laneWidth * 2);
  const movingRight = raw <= laneWidth;
  const x = movingRight ? raw : (laneWidth * 2 - raw);
  const frames = movingRight ? RIGHT_BIRD : LEFT_BIRD;
  const frame = frames[Math.floor(animationTick / 2) % frames.length] ?? frames[0];
  const status = mascotStatus(alerts);

  animationTick++;

  const leftMargin = 3;
  return frame.map((line, i) => {
    const left = " ".repeat(leftMargin + x);
    const suffix = i === 2 ? `   [ ${status.label} ]` : "";
    return colour(left + line + suffix, status.code + C.bold);
  }).join("\n");
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

function drawBoard(): void {
  if (!latestState) return;

  const { snapshots, alerts, meta } = latestState;
  clearScreen();

  const now = new Date();
  const hhmmss = now.toTimeString().slice(0, 8);

  console.log("");
  console.log(logo());
  console.log("");
  console.log(pixelCanary(alerts));
  console.log("");
  console.log(centerLine(colour("CANARY v0.3  /  Pons V2 read-only watchtower  /  Robinhood Chain 4663", C.cyan + C.bold)));
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

function ensureAnimation(): void {
  if (animationTimer || !process.stdout.isTTY) return;

  animationTimer = setInterval(() => {
    drawBoard();
  }, 120);

  // Do not keep one-shot commands alive just because the mascot is animated.
  animationTimer.unref();
}

export function renderBoard(snapshots: Snapshot[], alerts: Alert[], meta: BoardMeta): void {
  latestState = { snapshots, alerts, meta };
  drawBoard();
  ensureAnimation();
}
