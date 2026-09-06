# Rules

Every rule is a pure function over snapshots. There is no LLM, classifier or hidden score in the alert path.

## deployer-balance-drop · LEAVE

Fires when the Pons launch deployer's current token balance falls by more than `DEV_SELL_PCT` percentage points of total supply between sweeps.

This is deliberately named **balance drop**, not **sell**. A transfer or burn can produce the same on-chain balance change. Canary reports the observable fact and leaves intent to the human.

Default: `2` percentage points.

## curve-reserve-drop · LEAVE

Only active while both snapshots are Pons V2 phase `0` (bonding curve).

Fires when `realQuoteReserve()` falls by more than `LIQUIDITY_DROP_PCT` between sweeps. It is skipped across graduation so the protocol moving reserves into the next phase cannot masquerade as a danger alert.

Default: `15%`.

## fees-swept · WATCH

Only active on the curve.

Fires when `quoteFeeBalance() + creatorTaxBalance()` decreases. This means pending quote-denominated fees left the curve balance. It does **not** prove the creator claimed them from the fee escrow.

No threshold.

## volume-dead · WATCH

Only active on the curve.

Fires when the newest successfully indexed `CurveBuy` or `CurveSell` is older than `VOLUME_DEAD_MINUTES`.

If the RPC refuses the log query, Canary records last-trade time as unknown and the rule stays quiet. Missing data is not evidence of dead volume.

Default: `30` minutes.

## serial-deployer · WATCH

Fires when the same deployer appears in at least `SERIAL_DEPLOYER_COUNT` launches inside Canary's current factory index window.

It describes frequency only. It does not label the deployer malicious.

Default: `12` launches.

## phase-change · INFO

Fires when the authoritative Pons V2 launch phase changes:

```
0 curve
1 swept
2 pool
3 rescued
```

This is context, not a danger verdict.

## Ordering

`LEAVE` sorts before `WATCH`, then `INFO`.

## Deduplication

Same token + same rule is emitted at most once per 30 minutes inside one running process.
