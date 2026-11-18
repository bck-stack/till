// Collect the full loop of every sale and sweep from chain data (read-only) into deployments/loops.json and
// print a markdown table: origin tx -> Reactive (Lasna) tx -> callback tx on the destination, with timings.
import fs from "node:fs";
import { parseAbiItem } from "viem";
import { lane, reactive, loadDeployments, LANES, lasna } from "./net.mjs";

const d = loadDeployments();
const r = reactive();
const L = lane("base");
const ev = {
  sale: parseAbiItem("event Sale(uint256 indexed chainId, address indexed payer, uint256 amount, uint256 floatAfter, bool firstTimePayer)"),
  sweepConfirmed: parseAbiItem("event SweepConfirmed(uint256 indexed chainId, uint256 amount, uint256 floatAfter)"),
  shift: parseAbiItem("event ShiftClosed(uint256 indexed shift, uint256 gross, uint256 sales, uint256 payers)"),
  booked: parseAbiItem("event Booked(uint256 indexed chainId, address indexed payer, uint256 amount, uint256 originTx, bool firstTimePayer, uint256 floatAfter)"),
  sweepRecorded: parseAbiItem("event SweepRecorded(uint256 indexed chainId, uint256 amount, uint256 sweepTx)"),
  shiftRecorded: parseAbiItem("event ShiftRecorded(uint256 indexed shift, uint256 gross, uint256 sales, uint256 payers)"),
  swept: parseAbiItem("event Swept(address indexed vault, uint256 amount)"),
};
const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
const byChain = Object.fromEntries(Object.entries(LANES).map(([n, l]) => [l.chain.id, n]));

async function logsSince(client, address, event, fromBlock, step) {
  const head = await client.getBlockNumber();
  const out = [];
  for (let c = fromBlock; c <= head; c += step) {
    const to = c + step - 1n < head ? c + step - 1n : head;
    out.push(...(await client.getLogs({ address, event, fromBlock: c, toBlock: to })));
  }
  return out;
}
const blockOf = async (client, hash) => (await client.getTransactionReceipt({ hash })).blockNumber;
const timeOf = async (client, n) => Number((await client.getBlock({ blockNumber: n })).timestamp);

const lasnaFrom = await blockOf(r.pub, d.reactive.tx);
const baseFrom = await blockOf(L.pub, d.ledger.tx);
const [sales, confirms, shifts] = await Promise.all([ev.sale, ev.sweepConfirmed, ev.shift]
  .map((e) => logsSince(r.pub, d.reactive.address, e, lasnaFrom, 5000n)));
const [booked, sweepRec, shiftRec] = await Promise.all([ev.booked, ev.sweepRecorded, ev.shiftRecorded]
  .map((e) => logsSince(L.pub, d.ledger.address, e, baseFrom, 200n)));

// Reactive logs carry no origin hash, so pair them in order per chain (Reactive processes a chain's logs in order).
const loops = [];
const salesByChain = {};
for (const s of sales) (salesByChain[s.args.chainId] ??= []).push(s);
const bookedByChain = {};
for (const b of booked) (bookedByChain[b.args.chainId] ??= []).push(b);
for (const [chainId, list] of Object.entries(bookedByChain)) {
  const name = byChain[chainId];
  const O = lane(name);
  for (const [i, b] of list.entries()) {
    const origin = hex(b.args.originTx);
    const s = salesByChain[chainId]?.[i];
    const t0 = await timeOf(O.pub, await blockOf(O.pub, origin));
    const t1 = s ? await timeOf(r.pub, s.blockNumber) : null;
    const t2 = await timeOf(L.pub, b.blockNumber);
    loops.push({
      kind: "sale", chain: name, amount: Number(b.args.amount) / 1e6,
      origin: `${O.explorer}/tx/${origin}`,
      reactive: s ? `${lasna.blockExplorers.default.url}/tx/${s.transactionHash}` : null,
      callback: `${L.explorer}/tx/${b.transactionHash}`,
      seconds: { originToReactive: t1 && t1 - t0, originToCallback: t2 - t0 },
    });
  }
}
for (const rec of sweepRec) {
  const name = byChain[rec.args.chainId];
  const O = lane(name);
  const sweepTx = hex(rec.args.sweepTx);
  const c = confirms.find((x) => x.args.chainId === rec.args.chainId && x.args.amount === rec.args.amount);
  const t0 = await timeOf(O.pub, await blockOf(O.pub, sweepTx));
  loops.push({
    kind: "sweep", chain: name, amount: Number(rec.args.amount) / 1e6,
    origin: `${O.explorer}/tx/${sweepTx}`,
    reactive: c ? `${lasna.blockExplorers.default.url}/tx/${c.transactionHash}` : null,
    callback: `${L.explorer}/tx/${rec.transactionHash}`,
    seconds: { originToCallback: (await timeOf(L.pub, rec.blockNumber)) - t0 },
  });
}
for (const s of shiftRec) {
  const c = shifts.find((x) => x.args.shift === s.args.shift);
  loops.push({
    kind: "shift", shift: Number(s.args.shift), gross: Number(s.args.gross) / 1e6, sales: Number(s.args.sales),
    reactive: c ? `${lasna.blockExplorers.default.url}/tx/${c.transactionHash}` : null,
    callback: `${L.explorer}/tx/${s.transactionHash}`,
  });
}
fs.writeFileSync(new URL("../deployments/loops.json", import.meta.url), JSON.stringify(loops, null, 2) + "\n");
for (const l of loops) {
  console.log(`| ${l.kind} | ${l.chain ?? "-"} | ${l.amount ?? l.gross ?? ""} | ${l.origin ?? "cron tick"} | ${l.reactive ?? "-"} | ${l.callback} | ${l.seconds?.originToCallback ?? "-"} |`);
}
