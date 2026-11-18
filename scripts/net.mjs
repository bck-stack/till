// Networks, keys and compiled contracts shared by the scripts. Test networks only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia, unichainSepolia } from "viem/chains";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "lREACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
});

// Origin/destination chains with their Circle test USDC and Reactive callback proxy (dev.reactive.network).
export const LANES = {
  base: {
    chain: baseSepolia, rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", proxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
    explorer: "https://sepolia.basescan.org",
  },
  unichain: {
    chain: unichainSepolia, rpc: "https://sepolia.unichain.org",
    usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F", proxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
    explorer: "https://sepolia.uniscan.xyz",
  },
  sepolia: {
    chain: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", proxy: "0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4",
    explorer: "https://sepolia.etherscan.io",
  },
};
export const LEDGER_LANE = "base";
export const FAUCET_BASE_SEPOLIA = "0x2afaFD298b23b62760711756088F75B7409f5967"; // 1 ETH -> 100 lREACT

// Keys live outside the repo (TILL_ENV, default: ../tekleme işler/.env.reactive-testnet).
export function keys() {
  const file = process.env.TILL_ENV ?? path.resolve(root, "..", "tekleme işler", ".env.reactive-testnet");
  const env = Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=", 2)));
  return {
    deployer: privateKeyToAccount(env.DEPLOYER_KEY),
    payer: privateKeyToAccount(env.PAYER_KEY),
    vault: env.VAULT_ADDR,
  };
}

export function clients(chain, rpc, account) {
  const transport = http(rpc, { retryCount: 3 });
  return {
    pub: createPublicClient({ chain, transport }),
    wallet: account ? createWalletClient({ chain, transport, account }) : undefined,
  };
}

export function lane(name, account) {
  const l = LANES[name];
  if (!l) throw new Error(`unknown lane ${name}`);
  return { ...l, name, ...clients(l.chain, l.rpc, account) };
}

export function reactive(account) {
  return clients(lasna, lasna.rpcUrls.default.http[0], account);
}

export function artifact(name) {
  const p = path.join(root, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: a.abi, bytecode: a.bytecode };
}

const deploymentsFile = path.join(root, "deployments", "testnet.json");
export function loadDeployments() {
  return fs.existsSync(deploymentsFile) ? JSON.parse(fs.readFileSync(deploymentsFile, "utf8")) : {};
}
export function saveDeployments(d) {
  fs.mkdirSync(path.dirname(deploymentsFile), { recursive: true });
  fs.writeFileSync(deploymentsFile, JSON.stringify(d, null, 2) + "\n");
}
