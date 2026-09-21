# Architecture

Canary is split so protocol I/O and alert logic can be reasoned about separately.

```text
src/chain/reader.ts           interface + fixture reader
src/chain/rpc.ts              live Robinhood Chain / Pons V2 reader
src/chain/fallback-reader.ts  RPC fallback across configured endpoints
src/watch/signals.ts          deterministic rules
src/watch/sweep.ts            snapshot orchestration
src/watch/store.ts            restart-safe local state
src/alert/sink.ts             terminal + optional Telegram
src/ui/web-board.ts           persistent web board
src/ui/control-auth.ts        watcher start/stop protection
src/cli.ts                    command surface
```

## Live read path

`PonsV2Reader` creates only a viem **public client**. It does not create a wallet client, account, signer or transaction request.

For token discovery it indexes the configured Pons V2 factory's `TokenLaunched` event in bounded block chunks, takes the newest bounded set, and checks `balanceOf(wallet)`. Exact token pins bypass discovery.

For each token it reads the factory's `getLaunchedToken` record and standard ERC-20 state. While phase 0 it adds curve reserve / fee balances and recent `CurveBuy` + `CurveSell` events. In phase 2 it reconstructs the Pons Uniswap v4 pool id from the launch record and reads the canonical `StateView`, `PoolManager` swap events and the Pons hook fee balances.

## Why curve and pool are separated

Pons V2 changes venue at graduation. Curve reserve disappearing at that moment is expected protocol behavior, so cross-phase reserve comparisons are invalid. Rules that depend on curve semantics are disabled outside phase 0.

Pool rules added in v0.4 follow the same rule: they only compare two phase 2 snapshots, and they plugged in without changing `sweep` or the alert sinks.

## RPC pressure

Factory logs are read in `LOG_CHUNK_BLOCKS` windows with a short delay between chunks. `.canary/launch-index.json` persists the launch index and last indexed block across restarts. Wallet discovery is capped by `DISCOVERY_MAX_TOKENS`. Trade logs use a separate `TRADE_LOOKBACK_BLOCKS` window.

These defaults are designed to behave politely on a rate-limited public endpoint, not to replace an indexed data provider.

## State

Snapshots are written to `.canary/snapshots.json`. BigInts are serialized with an `n` suffix and restored as BigInts. A restart retains the previous baseline.

No private data is required. Wallet and token addresses are public chain identifiers.
