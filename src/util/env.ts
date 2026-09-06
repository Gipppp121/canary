/** Configuration. There is no key here, and no code path that would use one. */

import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_PONS_V2_FACTORY, DEFAULT_RPC_URL } from "../chain/config.js";

export interface Config {
  rpcUrl: string;
  rpcWsUrl: string;
  ponsFactory: string;
  wallets: string[];
  tokens: string[];
  pollSeconds: number;
  telegramToken: string;
  telegramChatId: string;
  devSellPct: number;
  liquidityDropPct: number;
  volumeDeadMinutes: number;
  serialDeployerCount: number;
  indexLookbackBlocks: number;
  tradeLookbackBlocks: number;
  logChunkBlocks: number;
  discoveryMaxTokens: number;
}

const DEFAULTS: Config = {
  rpcUrl: DEFAULT_RPC_URL,
  rpcWsUrl: "",
  ponsFactory: DEFAULT_PONS_V2_FACTORY,
  wallets: [],
  tokens: [],
  pollSeconds: 45,
  telegramToken: "",
  telegramChatId: "",
  devSellPct: 2,
  liquidityDropPct: 15,
  volumeDeadMinutes: 30,
  serialDeployerCount: 12,
  indexLookbackBlocks: 400_000,
  tradeLookbackBlocks: 20_000,
  logChunkBlocks: 20_000,
  discoveryMaxTokens: 250,
};

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

/** Anything that looks like signing material is refused, loudly, at load time. */
export class KeyRefused extends Error {
  constructor(where: string) {
    super(
      `canary found signing material in ${where}. Remove it. ` +
        `This tool reads and never signs, so a key here can only hurt you.`
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const suspicious of [
    "PRIVATE_KEY",
    "SECRET_KEY",
    "MNEMONIC",
    "SEED_PHRASE",
    "WALLET_PRIVATE_KEY",
  ]) {
    if (env[suspicious] && env[suspicious]!.trim() !== "") throw new KeyRefused(suspicious);
  }

  return {
    rpcUrl: env.RPC_URL?.trim() || DEFAULTS.rpcUrl,
    rpcWsUrl: env.RPC_WS_URL?.trim() || DEFAULTS.rpcWsUrl,
    ponsFactory: env.PONS_V2_FACTORY?.trim() || DEFAULTS.ponsFactory,
    wallets: list(env.WALLETS),
    tokens: list(env.TOKENS),
    pollSeconds: num(env.POLL_SECONDS, DEFAULTS.pollSeconds),
    telegramToken: env.TELEGRAM_TOKEN?.trim() || "",
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || "",
    devSellPct: num(env.DEV_SELL_PCT, DEFAULTS.devSellPct),
    liquidityDropPct: num(env.LIQUIDITY_DROP_PCT, DEFAULTS.liquidityDropPct),
    volumeDeadMinutes: num(env.VOLUME_DEAD_MINUTES, DEFAULTS.volumeDeadMinutes),
    serialDeployerCount: num(env.SERIAL_DEPLOYER_COUNT, DEFAULTS.serialDeployerCount),
    indexLookbackBlocks: num(env.INDEX_LOOKBACK_BLOCKS, DEFAULTS.indexLookbackBlocks),
    tradeLookbackBlocks: num(env.TRADE_LOOKBACK_BLOCKS, DEFAULTS.tradeLookbackBlocks),
    logChunkBlocks: num(env.LOG_CHUNK_BLOCKS, DEFAULTS.logChunkBlocks),
    discoveryMaxTokens: num(env.DISCOVERY_MAX_TOKENS, DEFAULTS.discoveryMaxTokens),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function isAddress(a: string): boolean {
  return ADDRESS.test(a);
}


/** Minimal .env loader: no interpolation, and real environment variables always win. */
export function loadLocalEnv(path = ".env", target: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || target[key] !== undefined) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    target[key] = value;
  }
}
