// Spread Ethereum Sepolia ETH from the deployer: lREACT from the Reactive faucet, and ETH bridged to the
// OP-stack test chains through their official L1StandardBridge contracts. Test networks only.
//   node scripts/fund.mjs lreact 0.028
//   node scripts/fund.mjs bridge base 0.01
//   node scripts/fund.mjs bridge unichain 0.01
import { parseAbi, parseEther } from "viem";
import { keys, lane, loadDeployments, saveDeployments } from "./net.mjs";

const FAUCET_SEPOLIA = "0x9b9BB25f1A81078C544C829c5EB7822d747Cf434"; // 1 ETH -> 100 lREACT
const L1_BRIDGE = {
  base: "0xfd0Bf71F60660E2f608ed56e1659C450eB113120",
  unichain: "0xea58fcA6849d79EAd1f26608855c2D6407d54Ce2",
};
const [what, a, b] = process.argv.slice(2);
const { deployer } = keys();
const s = lane("sepolia", deployer);
const d = loadDeployments();
d.funding ??= [];

let hash;
if (what === "lreact") {
  hash = await s.wallet.writeContract({
    address: FAUCET_SEPOLIA, abi: parseAbi(["function request(address) payable"]),
    functionName: "request", args: [deployer.address], value: parseEther(a),
  });
} else if (what === "bridge") {
  hash = await s.wallet.writeContract({
    address: L1_BRIDGE[a], abi: parseAbi(["function depositETH(uint32,bytes) payable"]),
    functionName: "depositETH", args: [200_000, "0x"], value: parseEther(b),
  });
} else {
  throw new Error("usage: lreact <eth> | bridge <base|unichain> <eth>");
}
const r = await s.pub.waitForTransactionReceipt({ hash });
console.log(what, a, b ?? "", r.status, `${s.explorer}/tx/${hash}`);
d.funding.push({ what, a, b, tx: hash, status: r.status });
saveDeployments(d);
