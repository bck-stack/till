// Make one test sale and time the loop: USDC transfer on the lane -> Reactive -> Booked on the ledger
// (and, if the float crosses the threshold, Swept on the lane -> SweepRecorded on the ledger).
//   node scripts/pay.mjs base 0.40
import { parseAbi, parseUnits, parseAbiItem, formatUnits } from "viem";
import { keys, lane, loadDeployments, LEDGER_LANE } from "./net.mjs";

const [name = "base", amountArg = "0.10", timeoutArg = "120"] = process.argv.slice(2);
const { deployer, payer } = keys();
const d = loadDeployments();
if (!d.ledger) throw new Error("deploy first");
const l = lane(name, payer);
const L = lane(LEDGER_LANE);
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const booked = parseAbiItem("event Booked(uint256 indexed chainId, address indexed payer, uint256 amount, uint256 originTx, bool firstTimePayer, uint256 floatAfter)");
const sweepRecorded = parseAbiItem("event SweepRecorded(uint256 indexed chainId, uint256 amount, uint256 sweepTx)");
const amount = parseUnits(amountArg, 6);

const fromBlock = await L.pub.getBlockNumber();
const t0 = Date.now();
const hash = await l.wallet.writeContract({ address: l.usdc, abi: erc20, functionName: "transfer", args: [deployer.address, amount] });
const rc = await l.pub.waitForTransactionReceipt({ hash });
// Some public RPCs return the receipt a moment before they serve the block.
let originBlock;
for (let i = 0; !originBlock; i++) {
  try { originBlock = await l.pub.getBlock({ blockNumber: rc.blockNumber }); }
  catch (e) { if (i > 10) throw e; await new Promise((r) => setTimeout(r, 1000)); }
}
const t1 = Date.now();
console.log(`sale     ${formatUnits(amount, 6)} USDC on ${name}  ${l.explorer}/tx/${hash}  (included after ${((t1 - t0) / 1000).toFixed(1)} s)`);

async function waitFor(event, args, match, label) {
  const deadline = Date.now() + Number(timeoutArg) * 1000;
  let cursor = fromBlock;
  while (Date.now() < deadline) {
    // Public Base Sepolia RPC serves eth_getLogs over at most 200 blocks (200 ms blocks), so walk in windows.
    const head = await L.pub.getBlockNumber();
    let hit;
    while (!hit && cursor <= head) {
      const to = cursor + 199n < head ? cursor + 199n : head;
      const logs = await L.pub.getLogs({ address: d.ledger.address, event, args, fromBlock: cursor, toBlock: to });
      hit = logs.find(match);
      if (!hit) cursor = to + 1n;
    }
    if (hit) {
      const b = await L.pub.getBlock({ blockNumber: hit.blockNumber });
      const chainSecs = Number(b.timestamp - originBlock.timestamp);
      console.log(`${label.padEnd(8)} ${L.explorer}/tx/${hit.transactionHash}  ` +
        `(${chainSecs} s block-to-block, ${((Date.now() - t1) / 1000).toFixed(1)} s wall clock after inclusion)`);
      return hit;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`${label.padEnd(8)} not seen within ${timeoutArg} s`);
  return null;
}

const hit = await waitFor(booked, { chainId: BigInt(l.chain.id) }, (x) => x.args.originTx === BigInt(hash), "booked");
if (hit) console.log(`         float on ${name} now ${formatUnits(hit.args.floatAfter, 6)} USDC, first-time payer: ${hit.args.firstTimePayer}`);
if (hit && process.env.TILL_WAIT_SWEEP) await waitFor(sweepRecorded, { chainId: BigInt(l.chain.id) }, () => true, "swept");
