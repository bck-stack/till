import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { decodeEventLog, keccak256, toHex, getAddress, type Hex } from "viem";

const { viem, provider } = await network.connect();
const SYSTEM = "0x8888888888888888888888888888888888888888";
const BASE = 84532n;
const UNI = 1301n;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const TRANSFER = BigInt(keccak256(toHex("Transfer(address,address,uint256)")));
const CRON1000 = 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4n;
const CRON_SOURCE = "0x0000000000000000000000000000000000fffFfF";

async function setup(threshold = USDC(1)) {
  const [owner, payTo, payer, payer2, vault, stranger] = await viem.getWalletClients();
  const impl = await viem.deployContract("MockSystem");
  const code = await provider.request({ method: "eth_getCode", params: [impl.address, "latest"] });
  await provider.request({ method: "hardhat_setCode", params: [SYSTEM, code] });
  const system = await viem.getContractAt("MockSystem", SYSTEM);
  // Storage at the system address survives between setups, so every test works from offsets.
  const subStart = await system.read.subCount();

  const proxy = await viem.deployContract("MockProxy");
  const usdcBase = await viem.deployContract("TestUSDC");
  const usdcUni = await viem.deployContract("TestUSDC");
  const till = await viem.deployContract("TillReactive", [payTo.account.address, BASE]);
  const ledger = await viem.deployContract("TillLedger", [proxy.address, till.address]);
  const sweepBase = await viem.deployContract("TillSweeper",
    [proxy.address, till.address, usdcBase.address, payTo.account.address, vault.account.address]);
  const sweepUni = await viem.deployContract("TillSweeper",
    [proxy.address, till.address, usdcUni.address, payTo.account.address, vault.account.address]);

  await till.write.setLedger([ledger.address]);
  await till.write.addLane([BASE, usdcBase.address, sweepBase.address, threshold]);
  await till.write.addLane([UNI, usdcUni.address, sweepUni.address, threshold]);
  for (const [u, s] of [[usdcBase, sweepBase], [usdcUni, sweepUni]] as const) {
    await u.write.mint([payer.account.address, USDC(100)]);
    await u.write.mint([payer2.account.address, USDC(100)]);
    await u.write.approve([s.address, 2n ** 256n - 1n], { account: payTo.account });
  }
  const cbStart = await system.read.callbackCount();
  return { subStart, cbStart, owner, payTo, payer, payer2, vault, stranger, system, proxy, usdcBase, usdcUni, till, ledger, sweepBase, sweepUni };
}

// Turn a real log from a local transaction into the LogRecord Reactive would hand to react(), tagged with the
// chain it is pretending to come from.
async function logRecord(hash: Hex, chainId: bigint, pick: (l: any) => boolean) {
  const publicClient = await viem.getPublicClient();
  const receipt = await publicClient.getTransactionReceipt({ hash });
  const l = receipt.logs.find(pick);
  assert.ok(l, "log not found");
  const t = l.topics.map((x: Hex) => BigInt(x));
  return {
    chainId, contractAddress: l.address, topic0: t[0] ?? 0n, topic1: t[1] ?? 0n, topic2: t[2] ?? 0n, topic3: t[3] ?? 0n,
    data: l.data, blockNumber: l.blockNumber, opCode: BigInt(l.topics.length), blockHash: BigInt(l.blockHash),
    txHash: BigInt(l.transactionHash), logIndex: BigInt(l.logIndex),
  };
}

async function pay(ctx: Awaited<ReturnType<typeof setup>>, chainId: bigint, from: any, amount: bigint) {
  const usdc = chainId === BASE ? ctx.usdcBase : ctx.usdcUni;
  const hash = await usdc.write.transfer([ctx.payTo.account.address, amount], { account: from.account });
  const rec = await logRecord(hash, chainId, (l) => getAddress(l.address) === getAddress(usdc.address));
  await ctx.system.write.deliver([ctx.till.address, rec]);
  return rec;
}

// Deliver every callback requested since `from` through the mock proxy, as the network would.
async function flush(ctx: Awaited<ReturnType<typeof setup>>, from?: bigint) {
  from ??= ctx.cbStart;
  const n = await ctx.system.read.callbackCount();
  const hashes: Hex[] = [];
  for (let i = from; i < n; i++) {
    const cb = await ctx.system.read.callbackAt([i]);
    hashes.push(await ctx.proxy.write.relay([cb.recipient, ctx.till.address, cb.payload]));
  }
  return { next: n, hashes };
}

describe("TillReactive subscriptions", () => {
  it("each lane subscribes to USDC transfers to payTo only, and to its sweeper", async () => {
    const { system, payTo, usdcBase, sweepBase, subStart } = await setup();
    assert.equal(await system.read.subCount(), subStart + 4n);
    const s0 = await system.read.subs([subStart]);
    assert.equal(s0[0], BASE);
    assert.equal(getAddress(s0[1]), getAddress(usdcBase.address));
    assert.equal(s0[2], TRANSFER);
    assert.equal(s0[4], BigInt(payTo.account.address)); // topic2 = recipient
    const s1 = await system.read.subs([subStart + 1n]);
    assert.equal(getAddress(s1[1]), getAddress(sweepBase.address));
  });

  it("only the owner can configure", async () => {
    const { till, stranger } = await setup();
    await assert.rejects(till.write.addLane([1n, SYSTEM, SYSTEM, 1n], { account: stranger.account }), /NotOwner/);
    await assert.rejects(till.write.setShiftClock([CRON1000], { account: stranger.account }), /NotOwner/);
  });

  it("react() rejects anyone but the system contract", async () => {
    const ctx = await setup();
    const hash = await ctx.usdcBase.write.transfer([ctx.payTo.account.address, 1n], { account: ctx.payer.account });
    const rec = await logRecord(hash, BASE, () => true);
    await assert.rejects(ctx.till.write.react([rec], { account: ctx.stranger.account }), /NotAuthorized/);
  });
});

describe("booking", () => {
  it("a payment is booked once on the ledger, with payer, amount and origin tx", async () => {
    const ctx = await setup();
    const rec = await pay(ctx, BASE, ctx.payer, USDC(0.25));
    const { hashes } = await flush(ctx);
    assert.equal(hashes.length, 1); // below threshold: book only, no sweep
    assert.equal(await ctx.ledger.read.totalGross(), USDC(0.25));
    assert.equal(await ctx.ledger.read.totalSales(), 1n);
    assert.equal(await ctx.ledger.read.payers(), 1n);
    const book = await ctx.ledger.read.books([BASE]);
    assert.equal(book[0], USDC(0.25));
    assert.equal(book[4], rec.txHash);
    // The same callback delivered twice does not double-count.
    const cb = await ctx.system.read.callbackAt([ctx.cbStart]);
    await ctx.proxy.write.relay([cb.recipient, ctx.till.address, cb.payload]);
    assert.equal(await ctx.ledger.read.totalSales(), 1n);
  });

  it("payments on two chains land in one ledger; payers are counted once", async () => {
    const ctx = await setup(USDC(50));
    await pay(ctx, BASE, ctx.payer, USDC(0.1));
    await pay(ctx, UNI, ctx.payer, USDC(0.2));
    await pay(ctx, UNI, ctx.payer2, USDC(0.3));
    await flush(ctx);
    assert.equal(await ctx.ledger.read.totalGross(), USDC(0.6));
    assert.equal(await ctx.ledger.read.chainCount(), 2n);
    assert.equal(await ctx.ledger.read.payers(), 2n);
    assert.equal(await ctx.till.read.payers(), 2n);
    assert.equal((await ctx.ledger.read.books([UNI]))[1], 2n);
  });

  it("transfers that are not to payTo, or from an unknown token, are ignored", async () => {
    const ctx = await setup();
    const other = await viem.deployContract("TestUSDC");
    await other.write.mint([ctx.payer.account.address, USDC(1)]);
    const h1 = await other.write.transfer([ctx.payTo.account.address, USDC(1)], { account: ctx.payer.account });
    await ctx.system.write.deliver([ctx.till.address, await logRecord(h1, BASE, () => true)]);
    const h2 = await ctx.usdcBase.write.transfer([ctx.stranger.account.address, USDC(1)], { account: ctx.payer.account });
    await ctx.system.write.deliver([ctx.till.address, await logRecord(h2, BASE, () => true)]);
    assert.equal(await ctx.system.read.callbackCount(), ctx.cbStart);
  });

  it("callbacks from any other reactive contract, or straight from an account, are refused", async () => {
    const ctx = await setup();
    await pay(ctx, BASE, ctx.payer, USDC(0.1));
    const cb = await ctx.system.read.callbackAt([ctx.cbStart]);
    await assert.rejects(ctx.proxy.write.relay([cb.recipient, ctx.stranger.account.address, cb.payload]), /RelayFailed/);
    await assert.rejects(ctx.ledger.write.book(
      [ctx.till.address, BASE, ctx.payer.account.address, 1n, 1n, 1n, true, 1n], { account: ctx.stranger.account }),
      /NotAuthorized/);
  });
});

describe("sweeping", () => {
  it("crossing the threshold sweeps the float to the vault, and the Swept event closes the loop", async () => {
    const ctx = await setup(USDC(1));
    await pay(ctx, BASE, ctx.payer, USDC(0.6));
    await pay(ctx, BASE, ctx.payer2, USDC(0.6)); // float 1.2 >= 1
    let { next, hashes } = await flush(ctx);
    assert.equal(hashes.length, 3); // book, book, sweep
    assert.equal(await ctx.usdcBase.read.balanceOf([ctx.vault.account.address]), USDC(1.2));
    assert.equal(await ctx.usdcBase.read.balanceOf([ctx.payTo.account.address]), 0n);
    assert.equal((await ctx.till.read.lanes([BASE]))[6], true); // pending until confirmed

    // Feed the sweeper's own event back, as Reactive would.
    const swept = await logRecord(hashes[2], BASE, (l) => getAddress(l.address) === getAddress(ctx.sweepBase.address));
    await ctx.system.write.deliver([ctx.till.address, swept]);
    const lane = await ctx.till.read.lanes([BASE]);
    assert.equal(lane[3], 0n); // float
    assert.equal(lane[6], false); // pending cleared
    ({ hashes } = await flush(ctx, next));
    assert.equal(hashes.length, 1);
    assert.equal(await ctx.ledger.read.totalSwept(), USDC(1.2));
    assert.equal((await ctx.ledger.read.books([BASE]))[3], 0n);
  });

  it("while a sweep is pending, more payments are booked but no second sweep is requested", async () => {
    const ctx = await setup(USDC(1));
    await pay(ctx, BASE, ctx.payer, USDC(1));
    await pay(ctx, BASE, ctx.payer, USDC(1));
    let sweeps = 0;
    const n = await ctx.system.read.callbackCount();
    for (let i = ctx.cbStart; i < n; i++) {
      const cb = await ctx.system.read.callbackAt([i]);
      if (getAddress(cb.recipient) === getAddress(ctx.sweepBase.address)) sweeps++;
    }
    assert.equal(sweeps, 1);
  });

  it("a sweep without allowance moves nothing, still reports, and the lane recovers", async () => {
    const ctx = await setup(USDC(1));
    await ctx.usdcBase.write.approve([ctx.sweepBase.address, 0n], { account: ctx.payTo.account });
    await pay(ctx, BASE, ctx.payer, USDC(2));
    const { hashes } = await flush(ctx);
    const publicClient = await viem.getPublicClient();
    const r = await publicClient.getTransactionReceipt({ hash: hashes[1] });
    const ev = decodeEventLog({ abi: ctx.sweepBase.abi, ...r.logs[0] });
    assert.equal(ev.eventName, "Swept");
    assert.equal((ev.args as any).amount, 0n);
    const swept = await logRecord(hashes[1], BASE, (l) => getAddress(l.address) === getAddress(ctx.sweepBase.address));
    await ctx.system.write.deliver([ctx.till.address, swept]);
    const lane = await ctx.till.read.lanes([BASE]);
    assert.equal(lane[3], USDC(2)); // float kept: nothing left the wallet
    assert.equal(lane[6], false);
  });

  it("the sweeper only pays the fixed vault and only on the reactive contract's request", async () => {
    const ctx = await setup();
    assert.equal(getAddress(await ctx.sweepBase.read.vault()), getAddress(ctx.vault.account.address));
    await assert.rejects(ctx.sweepBase.write.sweep([ctx.till.address], { account: ctx.stranger.account }), /NotAuthorized/);
  });
});

describe("shift clock", () => {
  it("a Cron tick closes the shift with the running totals; off by default; can be switched off", async () => {
    const ctx = await setup(USDC(50));
    await pay(ctx, BASE, ctx.payer, USDC(0.5));
    await pay(ctx, UNI, ctx.payer2, USDC(0.25));
    const { next } = await flush(ctx);
    const tick = {
      chainId: 5318007n, contractAddress: CRON_SOURCE, topic0: CRON1000, topic1: 0n, topic2: 0n, topic3: 0n,
      data: "0x" as Hex, blockNumber: 1000n, opCode: 1n, blockHash: 0n, txHash: 0n, logIndex: 0n,
    };
    await ctx.system.write.deliver([ctx.till.address, tick]); // clock off: ignored
    assert.equal(await ctx.till.read.shift(), 0n);

    await ctx.till.write.setShiftClock([CRON1000]);
    await ctx.system.write.deliver([ctx.till.address, tick]);
    assert.equal(await ctx.till.read.shift(), 1n);
    await flush(ctx, next);
    assert.equal(await ctx.ledger.read.lastShift(), 1n);

    await ctx.till.write.setShiftClock([0n]);
    const subs = await ctx.system.read.subCount();
    const last = await ctx.system.read.subs([subs - 1n]);
    assert.equal(last[6], false); // the cron subscription was removed
  });
});
