// Owner calls on the reactive contract.  node scripts/admin.mjs clock cron1000|cron10000|off
import { parseGwei } from "viem";
import { artifact, keys, reactive, loadDeployments, saveDeployments } from "./net.mjs";

const CRON = {
  cron1000: 0xe20b31294d84c3661ddc8f423abb9c70310d0cf172aa2714ead78029b325e3f4n, // ~18 min at Omni's ~1.07 s blocks
  cron10000: 0xd214e1d84db704ed42d37f538ea9bf71e44ba28bc1cc088b2f5deca654677a56n, // ~3 h
  off: 0n,
};
const [cmd, arg] = process.argv.slice(2);
const { deployer } = keys();
const r = reactive(deployer);
const d = loadDeployments();
const { abi } = artifact("TillReactive");
if (cmd !== "clock" || !(arg in CRON)) throw new Error("usage: clock cron1000|cron10000|off");
const hash = await r.wallet.writeContract({
  address: d.reactive.address, abi, functionName: "setShiftClock", args: [CRON[arg]], maxPriorityFeePerGas: parseGwei("1"),
});
const rc = await r.pub.waitForTransactionReceipt({ hash });
console.log("setShiftClock", arg, rc.status, hash);
d.clock = [...(d.clock ?? []), { clock: arg, tx: hash, at: new Date().toISOString() }];
saveDeployments(d);
