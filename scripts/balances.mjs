// Print native and USDC balances of the three test wallets on every network. Read-only.
import { formatEther, formatUnits, parseAbi } from "viem";
import { keys, lane, LANES, reactive } from "./net.mjs";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const { deployer, payer, vault } = keys();
const who = { deployer: deployer.address, payer: payer.address, vault };

const r = reactive();
for (const [role, addr] of Object.entries(who)) {
  console.log(`lasna     ${role.padEnd(8)} ${addr}  ${formatEther(await r.pub.getBalance({ address: addr }))} lREACT`);
}
for (const name of Object.keys(LANES)) {
  const l = lane(name);
  for (const [role, addr] of Object.entries(who)) {
    try {
      const eth = await l.pub.getBalance({ address: addr });
      const usdc = await l.pub.readContract({ address: l.usdc, abi: erc20, functionName: "balanceOf", args: [addr] });
      console.log(`${name.padEnd(9)} ${role.padEnd(8)} ${addr}  ${formatEther(eth)} ETH  ${formatUnits(usdc, 6)} USDC`);
    } catch (e) {
      console.log(`${name.padEnd(9)} ${role.padEnd(8)} error ${e.shortMessage ?? e.message}`);
    }
  }
}
