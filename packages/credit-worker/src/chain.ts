import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  type Address,
  parseUnits,
  formatUnits,
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
  "function mint(address to, uint256 amount) external",
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
  if (!/^[0-9a-f]{32}$/i.test(clean)) {
    throw new Error("Invalid UUID format for bytes32 conversion.");
  }
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

// ── Vault ──

const VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function vaultStats() view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)",
  "function supplyToEscrow(uint256 amount) external",
  "function recordRepayment(uint256 principal, uint256 fees) external",
  "function recordDefault(uint256 lossAmount) external",
]);

export async function getVaultStats(env: Env): Promise<{
  totalAssets: string;
  totalShares: string;
  sharePrice: string;
  idleBalance: string;
  inAave: string;
  inEscrow: string;
  feesEarned: string;
  defaultLoss: string;
} | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_VAULT) return null;

  try {
    const [assets, shares, price, idle, aave, escrow, fees, loss] = await clients.publicClient.readContract({
      address: env.CREDIT_VAULT as Address,
      abi: VAULT_ABI,
      functionName: "vaultStats",
    });
    return {
      totalAssets: formatUnits(assets, 6),
      totalShares: formatUnits(shares, 6),
      sharePrice: (Number(price) / 1e6).toFixed(6),
      idleBalance: formatUnits(idle, 6),
      inAave: formatUnits(aave, 6),
      inEscrow: formatUnits(escrow, 6),
      feesEarned: formatUnits(fees, 6),
      defaultLoss: formatUnits(loss, 6),
    };
  } catch (e) {
    console.error("Vault stats failed:", e);
    return null;
  }
}

export async function vaultSupplyToEscrow(env: Env, amount: number): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_VAULT) return null;

  const hash = await clients.walletClient.writeContract({
    address: env.CREDIT_VAULT as Address,
    abi: VAULT_ABI,
    functionName: "supplyToEscrow",
    args: [parseUnits(amount.toFixed(2), 6)],
  });
  return hash;
}

export async function vaultRecordRepayment(env: Env, principal: number, fees: number): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_VAULT) return null;

  const hash = await clients.walletClient.writeContract({
    address: env.CREDIT_VAULT as Address,
    abi: VAULT_ABI,
    functionName: "recordRepayment",
    args: [parseUnits(principal.toFixed(2), 6), parseUnits(fees.toFixed(2), 6)],
  });
  return hash;
}

export async function vaultRecordDefault(env: Env, lossAmount: number): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_VAULT) return null;

  const hash = await clients.walletClient.writeContract({
    address: env.CREDIT_VAULT as Address,
    abi: VAULT_ABI,
    functionName: "recordDefault",
    args: [parseUnits(lossAmount.toFixed(2), 6)],
  });
  return hash;
}

// ── Payment Verification ──

/** Verify a token transfer happened on-chain. Returns amount transferred or null. */
export async function verifyPayment(
  env: Env,
  txHash: string,
  expectedRecipient: string,
  minAmount: number,
): Promise<{ verified: boolean; amount: string; from: string } | null> {
  const clients = getClients(env);
  if (!clients || !env.TEST_USDC) return null;

  try {
    const receipt = await clients.publicClient.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });

    if (receipt.status !== "success") return { verified: false, amount: "0", from: "" };

    // Look for ERC-20 Transfer event: Transfer(address from, address to, uint256 value)
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const tokenAddr = env.TEST_USDC.toLowerCase();

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === tokenAddr &&
        log.topics[0] === transferTopic &&
        log.topics.length >= 3
      ) {
        const to = ("0x" + (log.topics[2] ?? "").slice(26)).toLowerCase();
        if (to !== expectedRecipient.toLowerCase()) continue;

        const value = BigInt(log.data);
        const amount = formatUnits(value, 6);
        const from = ("0x" + (log.topics[1] ?? "").slice(26)).toLowerCase();

        if (parseFloat(amount) >= minAmount) {
          return { verified: true, amount, from };
        }
      }
    }

    return { verified: false, amount: "0", from: "" };
  } catch (e) {
    console.error("Payment verification failed:", e);
    return null;
  }
}

// ── Vault Position ──

export async function getVaultPosition(env: Env, address: string): Promise<{
  shares: string;
  value: string;
  sharePrice: string;
} | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_VAULT) return null;

  try {
    const vaultAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function convertToAssets(uint256 shares) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function totalAssets() view returns (uint256)",
    ]);

    const shares = await clients.publicClient.readContract({
      address: env.CREDIT_VAULT as Address,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [address as Address],
    });

    const value = shares > 0n
      ? await clients.publicClient.readContract({
          address: env.CREDIT_VAULT as Address,
          abi: vaultAbi,
          functionName: "convertToAssets",
          args: [shares],
        })
      : 0n;

    const totalSupply = await clients.publicClient.readContract({
      address: env.CREDIT_VAULT as Address,
      abi: vaultAbi,
      functionName: "totalSupply",
    });

    const totalAssets = await clients.publicClient.readContract({
      address: env.CREDIT_VAULT as Address,
      abi: vaultAbi,
      functionName: "totalAssets",
    });

    const sharePrice = totalSupply > 0n
      ? (Number(totalAssets) / Number(totalSupply)).toFixed(6)
      : "1.000000";

    return {
      shares: formatUnits(shares, 6),
      value: formatUnits(value, 6),
      sharePrice,
    };
  } catch (e) {
    console.error("Vault position read failed:", e);
    return null;
  }
}

// ── Faucet ──

/** Mint TestUSDC to an agent address (testnet only — we own the contract). */
export async function mintTestTokens(
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
    functionName: "mint",
    args: [to as Address, amount],
  });

  return { txHash: hash, amount: formatUnits(amount, 6) };
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
