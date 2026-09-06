# Limitations

Canary is intentionally narrower than a trading terminal.

## Wallet discovery is bounded

Standard JSON-RPC cannot enumerate all ERC-20 balances for a wallet. Canary checks a bounded set of recent Pons V2 launches plus explicit token pins. If a position predates the window, use `TOKENS=` or `--token`.

## Post-graduation market activity is not indexed yet

Pons V2 moves graduated launches to Uniswap v4. Canary tracks the phase change and token/deployer state, but v0.2 does not reconstruct the pool id and v4 swap stream. Curve-specific reserve, volume and fee rules therefore stop after phase 0.

## Public RPCs can refuse historical logs

A failed trade-log read becomes `unknown`, not `zero`. That is why `volume-dead` cannot fire when the last-trade timestamp is unknown.

## Signals do not infer intent

A deployer balance drop may be a sell, transfer or burn. A curve reserve drop describes quote reserve leaving the curve; it is not proof of a rug. A fee sweep is not the same thing as a creator claim.

## Read-only is an implementation property, not a sandbox

This repository contains no signing/write path and CI checks for common write primitives. A modified fork can obviously add one. Review the exact commit you run.
