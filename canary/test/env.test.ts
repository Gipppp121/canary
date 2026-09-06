import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadLocalEnv, isAddress, KeyRefused } from "../src/util/env.js";

test("a private key in the environment is refused, not ignored", () => {
  assert.throws(
    () => loadConfig({ PRIVATE_KEY: "0xdeadbeef" } as NodeJS.ProcessEnv),
    KeyRefused
  );
});

test("a seed phrase is refused too", () => {
  assert.throws(
    () => loadConfig({ SEED_PHRASE: "witch collapse practice feed" } as NodeJS.ProcessEnv),
    KeyRefused
  );
});

test("an empty key variable is not a key", () => {
  const cfg = loadConfig({ PRIVATE_KEY: "  " } as NodeJS.ProcessEnv);
  assert.equal(cfg.wallets.length, 0);
});

test("defaults are sane with an empty environment", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.pollSeconds, 45);
  assert.equal(cfg.devSellPct, 2);
  assert.ok(cfg.rpcUrl.startsWith("https://"));
});

test("wallets parse from a comma list", () => {
  const cfg = loadConfig({ WALLETS: "0xaaa, 0xbbb ,," } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.wallets, ["0xaaa", "0xbbb"]);
});

test("a bad number falls back instead of poisoning the config", () => {
  const cfg = loadConfig({ POLL_SECONDS: "banana" } as NodeJS.ProcessEnv);
  assert.equal(cfg.pollSeconds, 45);
});

test("address shape is checked", () => {
  assert.ok(isAddress("0x" + "a".repeat(40)));
  assert.ok(!isAddress("0xtooshort"));
  assert.ok(!isAddress("not an address"));
});


test("local .env fills missing values but never overrides exported ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "POLL_SECONDS=99\nRPC_URL=https://from-file.example\n");
  const target = { RPC_URL: "https://already-exported.example" } as NodeJS.ProcessEnv;
  loadLocalEnv(file, target);
  assert.equal(target.POLL_SECONDS, "99");
  assert.equal(target.RPC_URL, "https://already-exported.example");
});
