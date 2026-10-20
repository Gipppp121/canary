# Limitations

Canary is intentionally narrower than a trading terminal.

## Wallet discovery is bounded

Standard JSON-RPC cannot enumerate all ERC-20 balances for a wallet. Canary checks a bounded set of recent Pons V2 launches plus explicit token pins. If a position predates the window, use `TOKENS=` or `--token`.

## Pool activity is a bounded window, not lifetime volume

Since v0.4, Canary reconstructs the Pons Uniswap v4 pool id for graduated launches and reads price, active liquidity, hook fees and recent swaps directly. Swap history only covers the last `TRADE_LOOKBACK_BLOCKS` blocks (default `20000`). Canary does not claim lifetime v4 volume.

Curve-specific reserve, volume and fee rules still stop after phase 0, and pool rules only run while both snapshots are in phase 2. A comparison is never made across the graduation boundary.

## Public RPCs can refuse historical logs

A failed trade-log read becomes `unknown`, not `zero`. That is why `volume-dead` cannot fire when the last-trade timestamp is unknown.

A failed curve reserve or curve fee read skips the token for that sweep, or moves on to an `RPC_FALLBACK_URLS` endpoint, instead of recording `0`. A failed Pons hook fee read leaves the pool token fees unknown. Neither is compared against the previous sweep.

## Signals do not infer intent

A deployer balance drop may be a sell, transfer or burn. A curve reserve drop describes quote reserve leaving the curve; it is not proof of a rug. A fee sweep is not the same thing as a creator claim.

## Read-only is an implementation property, not a sandbox

This repository contains no signing/write path and CI checks for common write primitives. A modified fork can obviously add one. Review the exact commit you run.
