# Till

**A cash register for sellers who get paid in USDC on more than one chain, run entirely by Reactive Network.**

We sell pay-per-call APIs over [x402](https://x402.org): every call is a small USDC payment to one merchant
address, and the payments arrive on several chains. Three chores came with that, and each used to need a script
and a server: write every sale into the books, move the float out of the hot wallet before it grows, and close
the day. Till does all three with no server and no keeper:

1. **Book every sale.** A reactive contract on Reactive Network subscribes to USDC `Transfer` events *to* the
   merchant address on each chain. Every payment triggers a callback that books it on one ledger contract
   (Base Sepolia): payer, amount, origin transaction, running float, first-time payer flag. Redelivered
   callbacks are ignored, so nothing is counted twice.
2. **Sweep the float.** When the float on a chain crosses its threshold, the reactive contract calls the sweeper
   on *that* chain, which moves the merchant's USDC to a vault fixed at deployment. The float is only reset when
   the sweeper's own `Swept` event comes back through Reactive, so a failed or partial sweep is never mistaken
   for a successful one, and only one sweep per chain is ever in flight.
3. **Close the shift.** Optionally, on a Reactive Network Cron tick, the running totals are written to the ledger
   as a closed shift.

```
 Base Sepolia                         Reactive Lasna                       Base Sepolia (ledger)
 USDC.Transfer(payer -> merchant) ──► TillReactive.react()  ── callback ──► TillLedger.book()
 Unichain Sepolia                         │  float >= threshold
 USDC.Transfer(payer -> merchant) ──►     ├── callback ──► TillSweeper.sweep() (same chain) ──► vault
                                          │                     │ emits Swept
 TillSweeper.Swept ──────────────────►    ├── float -= moved ── callback ──► TillLedger.recordSweep()
 Cron tick (Reactive system) ────────►    └── callback ──────────────────► TillLedger.closeShift()
```

## Contracts

| Contract | Chain | Role |
|---|---|---|
| [`TillReactive`](contracts/TillReactive.sol) | Reactive (Lasna) | Subscriptions, float per chain, sweep and shift decisions, callback requests |
| [`TillLedger`](contracts/TillLedger.sol) | Base Sepolia | The books. Writable only by `TillReactive` through the callback proxy |
| [`TillSweeper`](contracts/TillSweeper.sol) | each lane | Moves the merchant's USDC to the fixed vault, up to the merchant's approval |

Safety properties, all tested:
- Ledger and sweepers accept calls only from the Reactive callback proxy **and** only on behalf of our reactive
  contract (`onlyServiceProvider` + `onlyCallbackSender`).
- `react()` accepts only the system contract. Transfers to other addresses, or from other tokens, cost nothing
  and change nothing.
- The sweeper can only send to the vault fixed in its constructor, and never more than the merchant approved.
  It never reverts; it always reports what it moved.

## Deployed (test networks)

See [`deployments/testnet.json`](deployments/testnet.json) for addresses and the transactions of the full loop.

## Run it

```bash
npm install
git submodule update --init        # Reactive Omni base contracts
npx hardhat test                   # 12 tests against a mocked system contract and callback proxy
node scripts/balances.mjs          # test wallet balances on every network
node scripts/deploy.mjs lreact 0.05    # Base Sepolia ETH -> lREACT at the faucet
node scripts/deploy.mjs all base,unichain
node scripts/pay.mjs base 0.40     # one sale, timed from origin block to the ledger's Booked event
```

Keys are read from a file outside the repo (`TILL_ENV`). Test networks only.

## License

MIT for this repository. The Reactive base contracts in `lib/reactive-lib-omni` are a git submodule under
their own terms.
