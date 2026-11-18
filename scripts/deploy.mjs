// Deploy Till on the test networks, step by step and resumable (state in deployments/testnet.json).
//   node scripts/deploy.mjs lreact 0.05        swap Base Sepolia ETH for lREACT at the faucet (1 ETH -> 100 lREACT)
//   node scripts/deploy.mjs all base,unichain  reactive on Lasna, ledger on Base Sepolia, a sweeper per lane, wiring
// Thresholds are in USDC (default 1). Funding amounts are the minimum that keeps callbacks flowing for a demo.
import { parseEther, parseAbi, parseUnits, getContractAddress } from "viem";
import { artifact, keys, lane, reactive, loadDeployments, saveDeployments, LEDGER_LANE, FAUCET_BASE_SEPOLIA } from "./net.mjs";

const [step = "all", arg = "base,unichain"] = process.argv.slice(2);
const threshold = parseUnits(process.env.TILL_THRESHOLD ?? "1", 6);
const FUND_REACTIVE = parseEther(process.env.TILL_FUND_REACTIVE ?? "2"); // lREACT
const FUND_CALLBACK = parseEther(process.env.TILL_FUND_CALLBACK ?? "0.002"); // ETH per callback contract
const { deployer, vault } = keys();
const d = loadDeployments();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function deploy(c, name, args, value) {
  const { abi, bytecode } = artifact(name);
  const hash = await c.wallet.deployContract({ abi, bytecode, args, value });
  const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${name} deploy failed ${hash}`);
  log(`${name} at ${r.contractAddress} (tx ${hash})`);
  return { address: r.contractAddress, tx: hash };
}

async function send(c, address, abi, functionName, args, value) {
  const hash = await c.wallet.writeContract({ address, abi, functionName, args, value });
  const r = await c.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${functionName} failed ${hash}`);
  log(`${functionName} ok (tx ${hash})`);
  return hash;
}

if (step === "lreact") {
  const eth = parseEther(arg === "base,unichain" ? "0.02" : arg);
  const b = lane("base", deployer);
  const abi = parseAbi(["function request(address) payable"]);
  const tx = await send(b, FAUCET_BASE_SEPOLIA, abi, "request", [deployer.address], eth);
  d.faucet = [...(d.faucet ?? []), { eth: arg, tx }];
  saveDeployments(d);
  process.exit(0);
}

const lanes = arg.split(",");
const r = reactive(deployer);
const till = artifact("TillReactive");

// 1. Reactive contract on Lasna. The ledger lives on Base Sepolia.
if (!d.reactive) {
  d.reactive = await deploy(r, "TillReactive", [deployer.address, BigInt(lane(LEDGER_LANE).chain.id)], FUND_REACTIVE);
  saveDeployments(d);
}

// 2. Ledger on the ledger lane, authorising only our reactive contract.
const L = lane(LEDGER_LANE, deployer);
if (!d.ledger) {
  d.ledger = await deploy(L, "TillLedger", [L.proxy, d.reactive.address], FUND_CALLBACK);
  saveDeployments(d);
}

// 3. A sweeper per lane, paying only the vault.
d.sweepers ??= {};
for (const name of lanes) {
  const l = lane(name, deployer);
  if (!d.sweepers[name]) {
    d.sweepers[name] = await deploy(l, "TillSweeper", [l.proxy, d.reactive.address, l.usdc, deployer.address, vault], FUND_CALLBACK);
    saveDeployments(d);
  }
  // The merchant lets its own sweeper move its USDC; the sweeper can only send it to the vault.
  if (!d.sweepers[name].approveTx) {
    const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);
    d.sweepers[name].approveTx = await send(l, l.usdc, erc20, "approve", [d.sweepers[name].address, 2n ** 256n - 1n]);
    saveDeployments(d);
  }
}

// 4. Wire the reactive contract: ledger once, then one lane per chain (this is where the subscriptions happen).
const ledgerNow = await r.pub.readContract({ address: d.reactive.address, abi: till.abi, functionName: "ledger" });
if (/^0x0+$/.test(ledgerNow)) {
  d.setLedgerTx = await send(r, d.reactive.address, till.abi, "setLedger", [d.ledger.address]);
  saveDeployments(d);
}
d.lanes ??= {};
for (const name of lanes) {
  if (d.lanes[name]) continue;
  const l = lane(name);
  const tx = await send(r, d.reactive.address, till.abi, "addLane", [BigInt(l.chain.id), l.usdc, d.sweepers[name].address, threshold]);
  d.lanes[name] = { chainId: l.chain.id, threshold: threshold.toString(), tx };
  saveDeployments(d);
}
log("done", JSON.stringify({ reactive: d.reactive.address, ledger: d.ledger.address }));
