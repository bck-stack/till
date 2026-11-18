// Verify the deployed contracts on Sourcify (Lasna, Base Sepolia, Unichain Sepolia all supported), using the exact
// standard-JSON input Hardhat compiled. Tries each build-info until the bytecode matches.
import fs from "node:fs";
import path from "node:path";
import { loadDeployments, LANES } from "./net.mjs";

const d = loadDeployments();
const dir = path.resolve("artifacts/build-info");
const builds = fs.readdirSync(dir).filter((f) => !f.endsWith(".output.json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f))));
const targets = [
  { chainId: 5318007, address: d.reactive.address, tx: d.reactive.tx, name: "TillReactive" },
  { chainId: LANES.base.chain.id, address: d.ledger.address, tx: d.ledger.tx, name: "TillLedger" },
  ...Object.entries(d.sweepers).map(([n, s]) => ({ chainId: LANES[n].chain.id, address: s.address, tx: s.tx, name: "TillSweeper" })),
];
const API = "https://sourcify.dev/server";

async function poll(id) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const j = await (await fetch(`${API}/v2/verify/${id}`)).json();
    if (j.isJobCompleted) return j;
  }
  return { error: "timeout" };
}

for (const t of targets) {
  const check = await (await fetch(`${API}/v2/contract/${t.chainId}/${t.address}`)).json().catch(() => ({}));
  if (check.match) { console.log(t.name, t.chainId, "already", check.match); continue; }
  let done = false;
  for (const b of builds) {
    const id = `project/contracts/${t.name}.sol:${t.name}`;
    if (!b.input.sources[`project/contracts/${t.name}.sol`]) continue;
    const res = await fetch(`${API}/v2/verify/${t.chainId}/${t.address}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ stdJsonInput: b.input, compilerVersion: b.solcLongVersion, contractIdentifier: id, creationTransactionHash: t.tx }),
    });
    const job = await res.json();
    if (!job.verificationId) { console.log(t.name, "submit error", JSON.stringify(job).slice(0, 200)); continue; }
    const out = await poll(job.verificationId);
    if (out.contract?.match || out.contract?.runtimeMatch) {
      console.log(t.name, t.chainId, t.address, "verified:", out.contract.match ?? out.contract.runtimeMatch);
      done = true; break;
    }
    console.log(t.name, "build", b.id.slice(-8), "no match:", (out.error?.message ?? out.error ?? "").toString().slice(0, 120));
  }
  if (!done) console.log(t.name, t.chainId, "NOT verified");
}
