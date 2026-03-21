import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
  parseUnits,
  formatUnits,
  toHex,
  pad,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Env } from "./types";

// ── ABIs (matched to deployed contracts on Sepolia) ──

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const ESCROW_ABI = parseAbi([
  "function issueAdvance(bytes32 advanceId, address agent, uint256 principal, uint256 fee) external",
  "function settle(bytes32 advanceId, uint256 payoutAmount) external",
  "function availableFunds() external view returns (uint256)",
  "function getAdvance(bytes32 advanceId) external view returns (address agent, uint256 principal, uint256 fee, bool settled)",
  "function stats() external view returns (uint256, uint256, uint256, uint256, uint256, uint256)",
]);

const REPUTATION_ABI = parseAbi([
  "function addReputation(address agent, uint256 score, string evidence) external",
  "function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount)",
]);

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

// ── Escrow Operations ──

/** Convert a UUID string to bytes32 for the escrow contract */
function uuidToBytes32(uuid: string): Hex {
  const clean = uuid.replace(/-/g, "");
  return pad(`0x${clean}` as Hex, { size: 32 });
}

/** Issue advance via escrow contract (transfers tokens from escrow to agent) */
export async function escrowIssueAdvance(
  env: Env,
  advanceId: string,
  agentAddress: string,
  principal: number,
  fee: number,
): Promise<{ txHash: string } | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_ESCROW) return null;

  const id = uuidToBytes32(advanceId);
  const principalWei = parseUnits(principal.toFixed(2), 6);
  const feeWei = parseUnits(fee.toFixed(2), 6);

  const hash = await clients.walletClient.writeContract({
    address: env.CREDIT_ESCROW as Address,
    abi: ESCROW_ABI,
    functionName: "issueAdvance",
    args: [id, agentAddress as Address, principalWei, feeWei],
  });

  return { txHash: hash };
}

/** Settle an advance via escrow (caller sends payout, escrow runs waterfall) */
export async function escrowSettle(
  env: Env,
  advanceId: string,
  payoutAmount: number,
): Promise<{ txHash: string } | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_ESCROW || !env.TEST_USDC) return null;

  const id = uuidToBytes32(advanceId);
  const amount = parseUnits(payoutAmount.toFixed(2), 6);

  // First approve the escrow to pull tokens from the worker wallet
  const approveHash = await clients.walletClient.writeContract({
    address: env.TEST_USDC as Address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [env.CREDIT_ESCROW as Address, amount],
  });

  // Wait for approval
  await clients.publicClient.waitForTransactionReceipt({ hash: approveHash });

  // Now settle
  const hash = await clients.walletClient.writeContract({
    address: env.CREDIT_ESCROW as Address,
    abi: ESCROW_ABI,
    functionName: "settle",
    args: [id, amount],
  });

  return { txHash: hash };
}

/** Get escrow stats */
export async function getEscrowStats(env: Env): Promise<{
  totalDeposited: string;
  totalAdvanced: string;
  totalRepaid: string;
  totalFeesEarned: string;
  totalDefaultLoss: string;
  balance: string;
} | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_ESCROW) return null;

  const [deposited, advanced, repaid, fees, loss, balance] = await clients.publicClient.readContract({
    address: env.CREDIT_ESCROW as Address,
    abi: ESCROW_ABI,
    functionName: "stats",
  });

  return {
    totalDeposited: formatUnits(deposited, 6),
    totalAdvanced: formatUnits(advanced, 6),
    totalRepaid: formatUnits(repaid, 6),
    totalFeesEarned: formatUnits(fees, 6),
    totalDefaultLoss: formatUnits(loss, 6),
    balance: formatUnits(balance, 6),
  };
}

// ── Legacy direct transfer (fallback when no escrow) ──

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

// ── Token balance ──

export async function getTokenBalance(env: Env, address: string): Promise<string | null> {
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
  // If escrow exists, read escrow balance
  if (env.CREDIT_ESCROW) {
    const stats = await getEscrowStats(env);
    return stats?.balance ?? null;
  }
  // Fallback: read wallet balance
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
    return await clients.walletClient.writeContract({
      address: env.REPUTATION_REGISTRY as Address,
      abi: REPUTATION_ABI,
      functionName: "addReputation",
      args: [agentAddress as Address, BigInt(Math.max(0, score)), evidence],
    });
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
    const [score, count] = await clients.publicClient.readContract({
      address: env.REPUTATION_REGISTRY as Address,
      abi: REPUTATION_ABI,
      functionName: "getReputation",
      args: [agentAddress as Address],
    });
    return { score: Number(score), attestationCount: Number(count) };
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

// ── Status ──

export function isChainEnabled(env: Env): boolean {
  return !!(env.CHAIN_RPC_URL && env.AGENT_PRIVATE_KEY && env.TEST_USDC);
}

export function isEscrowEnabled(env: Env): boolean {
  return isChainEnabled(env) && !!env.CREDIT_ESCROW;
}

export function getAgentWallet(env: Env): string | null {
  if (!env.AGENT_PRIVATE_KEY) return null;
  return privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex).address;
}
