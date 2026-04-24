import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
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
import { getChainConfig, getChainClients } from "./chains";
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
  "function returnToVault(address vault, uint256 amount) external",
  "function availableFunds() external view returns (uint256)",
  "function getAdvance(bytes32 advanceId) external view returns (address agent, uint256 principal, uint256 fee, bool settled)",
]);

const REPUTATION_ABI = parseAbi([
  "function addReputation(address agent, uint256 score, string evidence) external",
  "function getReputation(address agent) external view returns (uint256 score, uint256 attestationCount)",
]);

const IDENTITY_ABI = parseAbi([
  "function agentInfo(address agent) external view returns (string agentCardUri, bytes32 agentCardHash, uint64 registeredAt, uint64 updatedAt)",
]);

// ── Clients ──

function getClients(env: Env) {
  const config = getChainConfig(env, "base-sepolia");
  if (config) {
    const account = privateKeyToAccount(config.privateKey);
    const transport = http(config.rpcUrl);
    return {
      publicClient: createPublicClient({ chain: config.meta.viemChain, transport }),
      walletClient: createWalletClient({ chain: config.meta.viemChain, transport, account }),
      account,
    };
  }

  if (env.CHAIN_RPC_URL && env.AGENT_PRIVATE_KEY) {
    const transport = http(env.CHAIN_RPC_URL);
    const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex);
    return {
      publicClient: createPublicClient({ chain: sepolia, transport }),
      walletClient: createWalletClient({ chain: sepolia, transport, account }),
      account,
    };
  }

  return null;
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
  const token = env.TEST_USDC ?? env.BASE_SEPOLIA_USDC;
  if (!clients || !token) return null;

  const balance = await clients.publicClient.readContract({
    address: token as Address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address as Address],
  });
  return formatUnits(balance, 6);
}

export async function getTreasuryBalance(env: Env): Promise<string | null> {
  const vault = await getVaultStats(env);
  if (vault) return vault.idleBalance;
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
): Promise<{
  registered: boolean;
  agentCardUri: string;
  agentCardHash: Hex;
  registeredAt: number;
  updatedAt: number;
} | null> {
  const clients = getClients(env);
  const config = getChainConfig(env, "base-sepolia");
  const registryAddress = (config?.identity ?? env.IDENTITY_REGISTRY) as Address | undefined;
  if (!clients || !registryAddress) return null;

  try {
    const [agentCardUri, agentCardHash, registeredAt, updatedAt] =
      await clients.publicClient.readContract({
        address: registryAddress,
        abi: IDENTITY_ABI,
        functionName: "agentInfo",
        args: [agentAddress as Address],
      });
    return {
      registered: registeredAt > 0n,
      agentCardUri,
      agentCardHash,
      registeredAt: Number(registeredAt),
      updatedAt: Number(updatedAt),
    };
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

const V31_VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalLPFeesEarned() view returns (uint256)",
  "function totalLiquidated() view returns (uint256)",
  "function outstandingPrincipal() view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
]);

function getVaultAddress(env: Env): Address | null {
  const addr = env.CREDIT_VAULT ?? env.BASE_SEPOLIA_ESCROW;
  return addr ? (addr as Address) : null;
}

export async function getVaultStats(env: Env): Promise<{
  totalAssets: string;
  totalShares: string;
  sharePrice: string;
  idleBalance: string;
  inEscrow: string;
  feesEarned: string;
  defaultLoss: string;
} | null> {
  const clients = getClients(env);
  const vault = getVaultAddress(env);
  if (!clients || !vault) return null;

  try {
    const oneShare = BigInt(1e12);
    const [assets, shares, priceRaw, fees, loss, outstanding, idle] = await Promise.all([
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "totalAssets" }),
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "totalSupply" }),
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "convertToAssets", args: [oneShare] }),
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "totalLPFeesEarned" }),
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "totalLiquidated" }),
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "outstandingPrincipal" }),
      clients.publicClient.readContract({ address: vault, abi: V31_VAULT_ABI, functionName: "availableLiquidity" }),
    ]);
    return {
      totalAssets: formatUnits(assets, 6),
      totalShares: formatUnits(shares, 12),
      sharePrice: formatUnits(priceRaw, 6),
      idleBalance: formatUnits(idle, 6),
      inEscrow: formatUnits(outstanding, 6),
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

// ── Escrow → Vault Capital Return ──

/** After settlement, return repaid capital from escrow back to the vault */
export async function escrowReturnToVault(
  env: Env,
  amount: number,
): Promise<string | null> {
  const clients = getClients(env);
  if (!clients || !env.CREDIT_ESCROW || !env.CREDIT_VAULT) return null;

  const amountWei = parseUnits(amount.toFixed(2), 6);
  const hash = await clients.walletClient.writeContract({
    address: env.CREDIT_ESCROW as Address,
    abi: ESCROW_ABI,
    functionName: "returnToVault",
    args: [env.CREDIT_VAULT as Address, amountWei],
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
  const vault = getVaultAddress(env);
  if (!clients || !vault) return null;

  try {
    const vaultAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function convertToAssets(uint256 shares) view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function totalAssets() view returns (uint256)",
    ]);

    const shares = await clients.publicClient.readContract({
      address: vault,
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
      address: vault,
      abi: vaultAbi,
      functionName: "totalSupply",
    });

    const totalAssets = await clients.publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssets",
    });

    // V3.1: shares have 12 decimals (6 USDC + 6 offset), assets have 6
    const oneShare = BigInt(1e12);
    const priceRaw = totalSupply > 0n
      ? await clients.publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [oneShare] })
      : BigInt(1e6);

    return {
      shares: formatUnits(shares, 12),
      value: formatUnits(value, 6),
      sharePrice: formatUnits(priceRaw, 6),
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
  if (env.CHAIN_RPC_URL && env.AGENT_PRIVATE_KEY && env.TEST_USDC) return true;
  const config = getChainConfig(env, "base-sepolia");
  return !!config;
}

export function isEscrowEnabled(env: Env): boolean {
  if (isChainEnabled(env) && env.CREDIT_ESCROW) return true;
  const config = getChainConfig(env, "base-sepolia");
  return !!(config?.escrow);
}

export function getAgentWallet(env: Env): string | null {
  const key = env.AGENT_PRIVATE_KEY ?? env.BASE_SEPOLIA_PRIVATE_KEY;
  if (!key) return null;
  return privateKeyToAccount(key as Hex).address;
}

// ═══════════════════════════════════════════════════════════════
// TrustlessEscrow (Base Sepolia) — on-chain enforced advances
// ═══════════════════════════════════════════════════════════════

const TRUSTLESS_ESCROW_ABI = parseAbi([
  "function requestAdvance(address oracle, bytes32 receivableId, uint256 requestedAmount) external returns (bytes32 advanceId)",
  "function settle(bytes32 advanceId, uint256 payoutAmount) external",
  "function liquidate(bytes32 advanceId) external",
  "function getAdvance(bytes32 advanceId) external view returns (address agent, address oracle, bytes32 receivableId, uint256 principal, uint256 fee, bool settled, uint256 expiresAt, bool liquidated)",
  "function exposure(address agent) external view returns (uint256)",
  "function availableLiquidity() external view returns (uint256)",
  "function rawBalance() external view returns (uint256)",
  "function oracleAdvanceRatioBps(address oracle) external view returns (uint256)",
  "function minCreditScore() external view returns (uint256)",
  "function feeBps() external view returns (uint256)",
  "function hardCapPerAdvance() external view returns (uint256)",
  "function maxExposurePerAgent() external view returns (uint256)",
  "function advanceDuration() external view returns (uint256)",
  "function timelockDelay() external view returns (uint256)",
  "function totalLiquidated() external view returns (uint256)",
  "function usedReceivables(bytes32) external view returns (bool)",
]);

const RECEIVABLE_ORACLE_ABI = parseAbi([
  "function register(bytes32 id, address beneficiary, uint256 amount) external",
  "function settle(bytes32 id) external",
  "function getReceivable(bytes32 receivableId) external view returns (bool exists, address beneficiary, uint256 amount, bool settled)",
]);

const CREDIT_ORACLE_ABI = parseAbi([
  "function getCredit(address agent) external view returns (uint256 score, uint256 totalExposure, uint256 maxExposure)",
]);

/** Check if Base Sepolia TrustlessEscrow path is available */
export function isTrustlessEnabled(env: Env): boolean {
  const config = getChainConfig(env, "base-sepolia");
  return !!config?.escrow;
}

/** Get TrustlessEscrow deployment info for agent-facing responses */
export function getTrustlessConfig(env: Env): {
  chain: string;
  chainId: number;
  escrow: string;
  oracle: string;
  creditOracle: string;
  usdc: string;
  explorer: string;
} | null {
  const config = getChainConfig(env, "base-sepolia");
  if (!config?.escrow) return null;
  return {
    chain: "base-sepolia",
    chainId: 84532,
    escrow: config.escrow,
    oracle: env.BASE_SEPOLIA_ORACLE ?? "",
    creditOracle: env.BASE_SEPOLIA_CREDIT_ORACLE ?? "",
    usdc: config.token,
    explorer: "https://sepolia.basescan.org",
  };
}

/** Read TrustlessEscrow parameters */
export async function getTrustlessParams(env: Env): Promise<{
  minCreditScore: number;
  feeBps: number;
  hardCap: string;
  liquidity: string;
  maxExposurePerAgent: string;
  advanceDurationSeconds: number;
  timelockDelaySeconds: number;
  oracleRatioBps: number | null;
} | null> {
  const config = getChainConfig(env, "base-sepolia");
  if (!config?.escrow) return null;
  const { publicClient } = getChainClients(config);

  const [minScore, fee, hardCap, liquidity] = await Promise.all([
    publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "minCreditScore" }),
    publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "feeBps" }),
    publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "hardCapPerAdvance" }),
    publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "availableLiquidity" }),
  ]);

  // Read extended params (may not exist on old contract)
  let maxExposurePerAgent = "not set";
  let advanceDurationSeconds = 0;
  let timelockDelaySeconds = 0;
  let oracleRatioBps: number | null = null;
  try {
    const oracleAddr = env.BASE_SEPOLIA_ORACLE ?? "";
    const [maxExposure, duration, timelock, oracleRatio] = await Promise.all([
      publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "maxExposurePerAgent" }),
      publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "advanceDuration" }),
      publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "timelockDelay" }),
      oracleAddr ? publicClient.readContract({ address: config.escrow, abi: TRUSTLESS_ESCROW_ABI, functionName: "oracleAdvanceRatioBps", args: [oracleAddr as `0x${string}`] }) : Promise.resolve(0n),
    ]);
    maxExposurePerAgent = formatUnits(maxExposure, 6);
    advanceDurationSeconds = Number(duration);
    timelockDelaySeconds = Number(timelock);
    oracleRatioBps = Number(oracleRatio);
  } catch { /* old contract */ }

  return {
    minCreditScore: Number(minScore),
    feeBps: Number(fee),
    hardCap: formatUnits(hardCap, 6),
    liquidity: formatUnits(liquidity, 6),
    maxExposurePerAgent,
    advanceDurationSeconds,
    timelockDelaySeconds,
    oracleRatioBps,
  };
}

/** Read agent's on-chain credit from ReputationCreditOracle */
export async function getOnchainCredit(env: Env, agentAddress: string): Promise<{
  score: number;
  totalExposure: string;
  maxExposure: string;
} | null> {
  const config = getChainConfig(env, "base-sepolia");
  const creditOracleAddr = env.BASE_SEPOLIA_CREDIT_ORACLE;
  if (!config || !creditOracleAddr) return null;
  const { publicClient } = getChainClients(config);

  try {
    const [score, exposure, maxExposure] = await publicClient.readContract({
      address: creditOracleAddr as Address,
      abi: CREDIT_ORACLE_ABI,
      functionName: "getCredit",
      args: [agentAddress as Address],
    });
    return {
      score: Number(score),
      totalExposure: formatUnits(exposure, 6),
      maxExposure: formatUnits(maxExposure, 6),
    };
  } catch (e) {
    console.error("On-chain credit check failed:", e);
    return null;
  }
}

/** Check receivable state on-chain */
export async function getReceivableState(env: Env, receivableId: Hex): Promise<{
  exists: boolean;
  beneficiary: string;
  amount: string;
  settled: boolean;
} | null> {
  const config = getChainConfig(env, "base-sepolia");
  const oracleAddr = env.BASE_SEPOLIA_ORACLE;
  if (!config || !oracleAddr) return null;
  const { publicClient } = getChainClients(config);

  try {
    const [exists, beneficiary, amount, settled] = await publicClient.readContract({
      address: oracleAddr as Address,
      abi: RECEIVABLE_ORACLE_ABI,
      functionName: "getReceivable",
      args: [receivableId],
    });
    return {
      exists,
      beneficiary,
      amount: formatUnits(amount, 6),
      settled,
    };
  } catch {
    return null;
  }
}

/** Register a receivable on-chain (worker funds it as protocol-sponsored receivable) */
export async function registerReceivable(
  env: Env,
  receivableId: Hex,
  beneficiary: string,
  amountUsdc: number,
): Promise<{ txHash: string } | null> {
  const config = getChainConfig(env, "base-sepolia");
  const oracleAddr = env.BASE_SEPOLIA_ORACLE;
  if (!config || !oracleAddr) return null;
  const { walletClient, publicClient, account } = getChainClients(config);
  const amount = parseUnits(amountUsdc.toFixed(2), 6);

  // Approve oracle to pull USDC from worker wallet
  const approveHash = await walletClient.writeContract({
    address: config.token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [oracleAddr as Address, amount],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // Register receivable
  const hash = await walletClient.writeContract({
    address: oracleAddr as Address,
    abi: RECEIVABLE_ORACLE_ABI,
    functionName: "register",
    args: [receivableId, beneficiary as Address, amount],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { txHash: hash };
}

/** Build calldata for agent to call requestAdvance() on TrustlessEscrow */
export function buildAdvanceCalldata(
  oracleAddress: string,
  receivableId: Hex,
  requestedAmount: number,
): Hex {
  return encodeFunctionData({
    abi: TRUSTLESS_ESCROW_ABI,
    functionName: "requestAdvance",
    args: [oracleAddress as Address, receivableId, parseUnits(requestedAmount.toFixed(2), 6)],
  });
}

/** Verify a trustless advance was issued on-chain */
export async function verifyTrustlessAdvance(
  env: Env,
  txHash: string,
): Promise<{
  advanceId: string;
  agent: string;
  oracle: string;
  receivableId: string;
  principal: string;
  fee: string;
} | null> {
  const config = getChainConfig(env, "base-sepolia");
  if (!config?.escrow) return null;
  const { publicClient } = getChainClients(config);

  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success") return null;

    // Match logs from the escrow contract to find AdvanceIssued events
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.escrow.toLowerCase()) continue;
      if (log.topics.length < 3) continue;

      // AdvanceIssued(bytes32 indexed advanceId, address indexed agent, ...)
      const advanceId = log.topics[1];
      if (!advanceId) continue;

      // Read the advance state from the contract for clean, authoritative data
      const [agent, oracle, receivableId, principal, fee] =
        await publicClient.readContract({
          address: config.escrow,
          abi: TRUSTLESS_ESCROW_ABI,
          functionName: "getAdvance",
          args: [advanceId as Hex],
        });

      if (agent === "0x0000000000000000000000000000000000000000") continue;

      return {
        advanceId,
        agent,
        oracle,
        receivableId,
        principal: formatUnits(principal, 6),
        fee: formatUnits(fee, 6),
      };
    }
    return null;
  } catch (e) {
    console.error("Trustless advance verification failed:", e);
    return null;
  }
}
