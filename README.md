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

| Contract | Network | Address |
|---|---|---|
| TillReactive | Reactive Lasna | [`0xfefeca149a7384a0c9f6968e93f52a1f16c81ffe`](https://lasna.reactscan.net/address/0xfefeca149a7384a0c9f6968e93f52a1f16c81ffe) |
| TillLedger | Base Sepolia | [`0xf6d266c64d7b2532c916b888ef17a32bccc1e83a`](https://sepolia.basescan.org/address/0xf6d266c64d7b2532c916b888ef17a32bccc1e83a) |
| TillSweeper | Base Sepolia | [`0x9dee59e6f11eb183edc4b3969ef5418c1042bd90`](https://sepolia.basescan.org/address/0x9dee59e6f11eb183edc4b3969ef5418c1042bd90) |
| TillSweeper | Unichain Sepolia | [`0xfefeca149a7384a0c9f6968e93f52a1f16c81ffe`](https://sepolia.uniscan.xyz/address/0xfefeca149a7384a0c9f6968e93f52a1f16c81ffe) |

All four are verified on [Sourcify](https://sourcify.dev) (exact match; `node scripts/verify.mjs`).

(The reactive contract and the Unichain sweeper share an address: both were the deployer's first transaction on
their chain.)

### The full loop, on-chain

Every row is origin event -> reactive transaction on Lasna -> callback on the destination. "Loop" is the time from
the origin block to the callback block.

| What | Chain | USDC | Origin | Reactive | Callback | Loop |
|---|---|---|---|---|---|---|
| sale | Base Sepolia | 0.40 | [0x4c21…](https://sepolia.basescan.org/tx/0x4c21990486673b055ff9d6ff84fc3190802b6abc9ac6226581ee10ac76b74aed) | [0x65e9…](https://lasna.reactscan.net/tx/0x65e9854bd8fd1e2d4e336befeaa29e74d1e02ccd7bda5936dd217cb69640c320) | [book 0xe223…](https://sepolia.basescan.org/tx/0xe22354b7e41cf7940e29ec322ce8b33ec4df547f2703098aeb2607d9b24862f2) | 3 s |
| sale | Unichain Sepolia | 0.25 | [0x7217…](https://sepolia.uniscan.xyz/tx/0x721792fdc1b5afe1b702dd4b17eccf6fb5e5915362c6a031c27756656ee240d0) | [0x9f7b…](https://lasna.reactscan.net/tx/0x9f7b6374f94dab0b148937c402d8d85d5c5be09e2e1b710925fb8d0d47aee24d) | [book 0x7369…](https://sepolia.basescan.org/tx/0x73690bf6e89a0446d964acb65862352bc22713b782def01f39bb32a9b0ce1bae) | 2 s |
| sale, crosses the 1 USDC threshold | Base Sepolia | 0.70 | [0x4f72…](https://sepolia.basescan.org/tx/0x4f7257334f5cf47fca62ccabde0065e3786313485383614e352719246447e272) | [0xdec7…](https://lasna.reactscan.net/tx/0xdec707e192217b85654aa8b792d02f8efa6d91b1b4393744cae5d4d441ec43f0) | [book 0x7633…](https://sepolia.basescan.org/tx/0x76331eaf74e7f8a932585d5d80eb472419890d6ee39e6d7830d48fa3599bd7c3) + sweep | 2 s |
| sweep confirmed | Base Sepolia | 1.50 | [Swept 0x572b…](https://sepolia.basescan.org/tx/0x572bbcdb4f34031b9531d7b7dbac5e4181ce0461c73d58bdcf1c2c00449e6191) | [0xfda1…](https://lasna.reactscan.net/tx/0xfda1aacf3c52fd97bf61161111a84576ba413e1b245f28b51e5855fb5ad9a77d) | [recordSweep 0x4513…](https://sepolia.basescan.org/tx/0x4513106e93eff8879859ecee4e82cec3d8e2402a8144eb5d331b63c6922d33e8) | 2 s |
| sale, crosses the threshold | Unichain Sepolia | 0.90 | [0xb8f9…](https://sepolia.uniscan.xyz/tx/0xb8f9c8a5a4768695f49f604bcf8429299376dbf14d9464196dc1defcae6b1809) | [0xea90…](https://lasna.reactscan.net/tx/0xea90231acf71eeb2e45957a4b10bdf15b714f1de8b054153ecd58ac4d0f7a130) | [book 0xff9c…](https://sepolia.basescan.org/tx/0xff9ca61b1eee04d8a7814f7f73e44f1d5db0439e2815a5671c01c97781b2a387) + sweep | 1 s |
| sweep confirmed | Unichain Sepolia | 1.15 | [Swept 0xb6e1…](https://sepolia.uniscan.xyz/tx/0xb6e11ed7910d0ae8a86cd89e73a3fd4820938f266df10691ecac3406ca24189b) | [0xac2a…](https://lasna.reactscan.net/tx/0xac2add5a24fff44aedb866720073915b19498ccd38b7886a9e193a2e4465fe23) | [recordSweep 0x4b28…](https://sepolia.basescan.org/tx/0x4b28a5319d2e31447d302c355332e71f35cfdf1a2ec51fca32dfe25d69ed56f1) | 1 s |
| shift closed (Cron1000 tick) | Reactive Lasna | 3.65 gross, 6 sales | Cron event | [0xc566…](https://lasna.reactscan.net/tx/0xc566745e401af4ccf668ccf9ce1844dce9fa742e57a7c8770347aeef5c98d0e7) | [closeShift 0x4706…](https://sepolia.basescan.org/tx/0x4706f6210df3ea01a35a1ce55f7c41e935dc22a14d656c1ea6936a9baa62dc20) | – |

The Base sweep moved 1.50 USDC although the booked float was 1.10: the sweeper moves the merchant's whole USDC
balance, and 0.40 USDC had arrived before this deployment was watching (a first deployment, kept in
[`deployments/testnet-v1-callback-gas-400k.json`](deployments/testnet-v1-callback-gas-400k.json), requested
callbacks with a 400k gas limit; the proxy keeps 130k of it, and a first booking needs ~255k, so the booking
failed with `CallbackFailure`. The gas limit is now 1M and owner-settable). The shift clock was switched on for this demonstration and off again afterwards (`node scripts/admin.mjs clock off`):
every tick is billed whether or not anything happened, so it stays off until a merchant wants it. `node scripts/evidence.mjs` rebuilds
this table from chain data into [`deployments/loops.json`](deployments/loops.json).

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
