import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
  parseUnits,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Env } from "./types";

// ── ABIs (matched to deployed contracts on Sepolia) ──

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

// ReputationRegistry ABI — from synthesis-hack-v2/packages/scripts/src/deploy-contracts.ts
const REPUTATION_ABI = parseAbi([
  "function addReputation(address agent, uint256 score, string evidence) external",
  "function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount)",
]);

// IdentityRegistry ABI — from same source
const IDENTITY_ABI = parseAbi([
  "function getAgent(address agent) external view returns (string name, string description, bool registered)",
]);

// ── Clients ──

function getClients(env: Env) {
  if (!env.CHAIN_RPC_URL || !env.AGENT_PRIVATE_KEY) return null;

  const transport = http(env.CHAIN_RPC_URL);
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex);

  return {
    publicClient: createPublicClient({ chain: sepolia, transport }),
    walletClient: createWalletClient({ chain: sepolia, transport, account }),
    account,
  };
}

// ── Token Transfers ──

export async function transferTokens(
  env: Env,
  to: string,
  amountUsd: number,
): Promise<{ txHash: string; amount: string } | null> {
  const clients = getClients(env);
  if (!clients || !env.TEST_USDC) return null;

  const amount = parseUnits(amountUsd.toFixed(2), 6);

  const hash = await clients.walletClient.writeContract({
    address: env.TEST_USDC as Address,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as Address, amount],
  });

  return { txHash: hash, amount: formatUnits(amount, 6) };
}

export async function getTokenBalance(
  env: Env,
  address: string,
): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.TEST_USDC) return null;

  const balance = await clients.publicClient.readContract({
    address: env.TEST_USDC as Address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address as Address],
  });

  return formatUnits(balance, 6);
}

export async function getTreasuryBalance(env: Env): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.TEST_USDC) return null;
  return getTokenBalance(env, clients.account.address);
}

// ── Reputation ──

export async function writeReputation(
  env: Env,
  agentAddress: string,
  score: number,
  evidence: string,
): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.REPUTATION_REGISTRY) return null;

  try {
    const hash = await clients.walletClient.writeContract({
      address: env.REPUTATION_REGISTRY as Address,
      abi: REPUTATION_ABI,
      functionName: "addReputation",
      args: [agentAddress as Address, BigInt(Math.max(0, score)), evidence],
    });
    return hash;
  } catch (e) {
    console.error("Reputation write failed:", e);
    return null;
  }
}

export async function getReputation(
  env: Env,
  agentAddress: string,
): Promise<{ score: number; attestationCount: number } | null> {
  const clients = getClients(env);
  if (!clients || !env.REPUTATION_REGISTRY) return null;

  try {
    const [score, attestationCount] = await clients.publicClient.readContract({
      address: env.REPUTATION_REGISTRY as Address,
      abi: REPUTATION_ABI,
      functionName: "getReputation",
      args: [agentAddress as Address],
    });
    return { score: Number(score), attestationCount: Number(attestationCount) };
  } catch {
    return null;
  }
}

export async function checkIdentityOnchain(
  env: Env,
  agentAddress: string,
): Promise<{ name: string; description: string; registered: boolean } | null> {
  const clients = getClients(env);
  if (!clients || !env.IDENTITY_REGISTRY) return null;

  try {
    const [name, description, registered] = await clients.publicClient.readContract({
      address: env.IDENTITY_REGISTRY as Address,
      abi: IDENTITY_ABI,
      functionName: "getAgent",
      args: [agentAddress as Address],
    });
    return { name, description, registered };
  } catch {
    return null;
  }
}

// ── Chain status ──

export function isChainEnabled(env: Env): boolean {
  return !!(env.CHAIN_RPC_URL && env.AGENT_PRIVATE_KEY && env.TEST_USDC);
}

export function getAgentWallet(env: Env): string | null {
  if (!env.AGENT_PRIVATE_KEY) return null;
  return privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex).address;
}
