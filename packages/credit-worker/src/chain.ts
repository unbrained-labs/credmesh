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

// ── ABIs ──

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const REPUTATION_ABI = parseAbi([
  "function addAttestation(address agent, string calldata attestationType, int256 score, string calldata metadata)",
]);

// ── Clients ──

function getClients(env: Env) {
  if (!env.CHAIN_RPC_URL || !env.AGENT_PRIVATE_KEY) {
    return null;
  }

  const transport = http(env.CHAIN_RPC_URL);
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex);

  const publicClient = createPublicClient({
    chain: sepolia,
    transport,
  });

  const walletClient = createWalletClient({
    chain: sepolia,
    transport,
    account,
  });

  return { publicClient, walletClient, account };
}

// ── Token Transfers ──

export async function transferTokens(
  env: Env,
  to: string,
  amountUsd: number,
): Promise<{ txHash: string; amount: string } | null> {
  const clients = getClients(env);
  if (!clients || !env.TEST_USDC) return null;

  const tokenAddress = env.TEST_USDC as Address;
  const toAddress = to as Address;

  // TestUSDC uses 6 decimals like real USDC
  const amount = parseUnits(amountUsd.toFixed(2), 6);

  const hash = await clients.walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [toAddress, amount],
  });

  return {
    txHash: hash,
    amount: formatUnits(amount, 6),
  };
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

// ── Reputation Attestations ──

export async function writeReputationAttestation(
  env: Env,
  agentAddress: string,
  attestationType: string,
  score: number,
  metadata: string,
): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.REPUTATION_REGISTRY) return null;

  try {
    const hash = await clients.walletClient.writeContract({
      address: env.REPUTATION_REGISTRY as Address,
      abi: REPUTATION_ABI,
      functionName: "addAttestation",
      args: [agentAddress as Address, attestationType, BigInt(score), metadata],
    });

    return hash;
  } catch (e) {
    console.error("Reputation attestation failed:", e);
    return null;
  }
}

// ── Chain status ──

export function isChainEnabled(env: Env): boolean {
  return !!(env.CHAIN_RPC_URL && env.AGENT_PRIVATE_KEY && env.TEST_USDC);
}

export function getAgentWallet(env: Env): string | null {
  if (!env.AGENT_PRIVATE_KEY) return null;
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex);
  return account.address;
}
