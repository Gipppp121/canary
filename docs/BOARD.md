# Canary board

The board is a live, read-only view over the same snapshots used by Canary's deterministic rules.

```bash
npm run canary -- watch --demo --board
npm run canary -- watch 0xWALLET --board --interval 10
npm run canary -- watch --token 0xTOKEN --board --interval 10
```

`Ctrl+C` stops the board. State under `.canary/` survives restarts.

## Status

| Label | Meaning |
|---|---|
| `QUIET` | no configured deterministic threshold crossed on this sweep |
| `WATCH` | a medium-severity condition deserves inspection |
| `LEAVE` | Canary's highest-severity local signal; still not a trade instruction |

## Common fields

| Field | Meaning |
|---|---|
| `dev` | deployer token balance as a share of current total supply |
| `phase` | Pons V2 routing state, e.g. `CURVE` or `POOL` |
| `signals` | number of deterministic signals on the current snapshot |
| `launches` | recent launches by the same deployer in Canary's indexed window |
| `deployer` | shortened deployer address read from the Pons V2 launch record |

## Curve phase

While a token is still on the Pons V2 bonding curve, the board can show:

- `reserve` — `realQuoteReserve()` in the pair asset
- pending curve fees
- recent `CurveBuy` / `CurveSell` count
- last observed curve trade

Curve-only rules stop when the token leaves the curve, so graduation cannot look like a fake reserve collapse.

## Pool phase

For graduated launches, Canary reconstructs the Pons Uniswap v4 pool id and reads the pool directly.

The board can show:

- current quote-per-token price derived from the live pool tick
- active Uniswap v4 liquidity
- recent pool swap count and last swap time over Canary's bounded lookback window
- pending quote-side hook fees
- pending launch-token hook fees
- current tick

`v4 L` is raw active Uniswap v4 liquidity, not TVL and not a quote reserve. Canary keeps those concepts separate on purpose.

## Evidence, not intent

Canary reports what its reads prove. A deployer balance drop can be a sell, transfer, or burn. A fee balance moving can have more than one cause. The board names the measured change and leaves intent to the human reviewing it.
